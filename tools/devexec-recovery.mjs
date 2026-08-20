import fs from "node:fs";
import path from "node:path";

const TERMINAL_PHASES = new Set(["COMPLETE", "FAILED", "NEEDS_HUMAN", "CANCELLED"]);

export function classifyRunState(state) {
 if (!state || typeof state !== "object") throw new Error("State must be an object.");
 if (!state.run_id) throw new Error("State is missing run_id.");

 if (state.pending) {
 return {
 run_id: state.run_id,
 classification: "AMBIGUOUS_EXEC_IN_FLIGHT",
 safe_to_continue: false,
 recommended_action: "inspect",
 phase: state.phase || null,
 step: state.step ?? null,
 pending_step: state.pending.step ?? null,
 };
 }

 const rounds = state.rounds && typeof state.rounds === "object" ? state.rounds : {};
 const inFlightRound = Object.entries(rounds).find((entry) => entry[1] && entry[1].send_state === "IN_FLIGHT");
 if (inFlightRound) {
 return {
 run_id: state.run_id,
 classification: "AMBIGUOUS_SUPERVISOR_IN_FLIGHT",
 safe_to_continue: false,
 recommended_action: "inspect",
 phase: state.phase || null,
 step: state.step ?? null,
 supervisor_round: Number(inFlightRound[0]),
 };
 }

 if (TERMINAL_PHASES.has(state.phase)) {
 return {
 run_id: state.run_id,
 classification: "TERMINAL",
 safe_to_continue: true,
 recommended_action: "continue",
 phase: state.phase,
 step: state.step ?? null,
 };
 }

 return {
 run_id: state.run_id,
 classification: "NONTERMINAL",
 safe_to_continue: false,
 recommended_action: "resume-existing-run",
 phase: state.phase || null,
 step: state.step ?? null,
 };
}

export function loadAndClassifyRunState(stateDir, runId) {
 if (!stateDir) throw new Error("stateDir is required.");
 if (!runId) throw new Error("runId is required.");
 const statePath = path.join(stateDir, runId + ".json");
 if (!fs.existsSync(statePath)) throw new Error("Run state not found: " + runId);
 const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
 if (state.run_id !== runId) throw new Error("State run_id mismatch.");
 return classifyRunState(state);
}


export function verifyEventJournal(runDir, runId) {
  if (!runDir) throw new Error("runDir is required.");
  if (!runId) throw new Error("runId is required.");
  const eventFile = path.join(runDir, "events.jsonl");
  if (!fs.existsSync(eventFile)) {
    return { run_id: runId, valid: false, classification: "MISSING_JOURNAL", event_count: 0 };
  }
  const raw = fs.readFileSync(eventFile, "utf8");
  const lines = raw.split(String.fromCharCode(10)).map((line) => line.trim()).filter((line) => line.length > 0);
  let previousAt = null;
  for (let i = 0; i < lines.length; i += 1) {
    let event;
    try { event = JSON.parse(lines[i]); } catch {
      return { run_id: runId, valid: false, classification: "INVALID_JSON", event_count: i, invalid_line: i + 1 };
    }
    if (event.protocol !== "dev-exec.event" || event.schema_version !== 1) {
      return { run_id: runId, valid: false, classification: "INVALID_EVENT_SCHEMA", event_count: i, invalid_line: i + 1 };
    }
    if (event.run_id !== runId) {
      return { run_id: runId, valid: false, classification: "RUN_ID_MISMATCH", event_count: i, invalid_line: i + 1 };
    }
    if (typeof event.state_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(event.state_sha256)) {
      return { run_id: runId, valid: false, classification: "INVALID_STATE_HASH", event_count: i, invalid_line: i + 1 };
    }
    if (!event.at || Number.isNaN(Date.parse(event.at))) {
      return { run_id: runId, valid: false, classification: "INVALID_TIMESTAMP", event_count: i, invalid_line: i + 1 };
    }
    if (previousAt && Date.parse(event.at) < Date.parse(previousAt)) {
      return { run_id: runId, valid: false, classification: "NON_MONOTONIC_TIMESTAMP", event_count: i, invalid_line: i + 1 };
    }
    previousAt = event.at;
  }
  return { run_id: runId, valid: true, classification: "VALID_JOURNAL", event_count: lines.length, last_at: previousAt };
}

export function inspectReceiptAwarePending(state, runDir) {
 if (!state.pending) return classifyRunState(state);
 const step = Number(state.pending.step);
 const stem = "step-" + String(step).padStart(3, "0");
 const rp = path.join(runDir, stem + ".receipt.json");
 const xp = path.join(runDir, stem + ".result.json");
 const bad = c => ({ run_id:state.run_id, classification:c, safe_to_continue:false, safe_to_reconcile:false, recommended_action:"inspect", pending_step:step });
 if (!fs.existsSync(rp) || !fs.existsSync(xp)) return bad("AMBIGUOUS_EXEC_IN_FLIGHT");
 let r, x;
 try { r=JSON.parse(fs.readFileSync(rp,"utf8")); x=JSON.parse(fs.readFileSync(xp,"utf8")); } catch { return bad("AMBIGUOUS_EXEC_ARTIFACT_INVALID"); }
 if (r.protocol !== "dev-exec.exec-receipt" || r.schema_version !== 1 || r.phase !== "RESULT_WRITTEN") return bad("AMBIGUOUS_EXEC_ARTIFACT_MISMATCH");
 if (x.protocol !== "dev-exec.result" || x.schema_version !== 1) return bad("AMBIGUOUS_EXEC_ARTIFACT_MISMATCH");
 if (r.run_id !== state.run_id || x.run_id !== state.run_id || Number(r.step) !== step || Number(x.step) !== step) return bad("AMBIGUOUS_EXEC_ARTIFACT_MISMATCH");
 if (r.scriptSha256 !== x.scriptSha256 || r.stdoutSha256 !== x.stdoutSha256 || r.stderrSha256 !== x.stderrSha256) return bad("AMBIGUOUS_EXEC_ARTIFACT_MISMATCH");
 return { run_id:state.run_id, classification:"RECOVERABLE_EXEC_RESULT_WRITTEN", safe_to_continue:false, safe_to_reconcile:true, recommended_action:"reconcile-result", pending_step:step, receipt_path:rp, result_path:xp, result:x };
}

export function loadAndInspectReceiptAwarePending(stateDir, runBase, runId) {
 if (!stateDir) throw new Error("stateDir is required.");
 if (!runBase) throw new Error("runBase is required.");
 if (!runId) throw new Error("runId is required.");
 const statePath = path.join(stateDir, runId + ".json");
 if (!fs.existsSync(statePath)) throw new Error("Run state not found: " + runId);
 const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
 if (state.run_id !== runId) throw new Error("State run_id mismatch.");
 return inspectReceiptAwarePending(state, path.join(runBase, runId));
}

export function reconcileReceiptAwarePending(stateDir, runBase, runId) {
 const p = path.join(stateDir, runId + ".json");
 const s = JSON.parse(fs.readFileSync(p, "utf8"));
 const i = inspectReceiptAwarePending(s, path.join(runBase, runId));
 if (!i.safe_to_reconcile) throw new Error("NOT_SAFE_TO_RECONCILE:" + i.classification);
 const r = i.result;
 if (Number(r.step) <= Number(s.step || 0)) throw new Error("RESULT_STEP_NOT_NEWER");
 s.step = Number(r.step);
 s.last_result = r;
 s.pending = null;
 s.phase = r.exitCode === 0 && !r.timedOut && !(r.stderr || "").trim() ? "STEP_PASS" : "STEP_FAIL";
 s.recovery = { classification:"RECOVERED_EXEC_RESULT_WRITTEN", execution_replayed:false, reconciled_step:s.step };
 const t = p + ".tmp";
 fs.writeFileSync(t, JSON.stringify(s, null, 2) + String.fromCharCode(10), "utf8");
 fs.renameSync(t, p);
 return { run_id:runId, classification:"RECOVERED_EXEC_RESULT_WRITTEN", safe_to_resume:true, execution_replayed:false, step:s.step, phase:s.phase };
}
