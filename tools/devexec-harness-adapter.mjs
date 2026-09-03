import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export const OUTER_SCHEMA = "devexec.harness-outer.v1";

const sha = (value) => crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : (typeof value === "string" ? value : JSON.stringify(value)), "utf8").digest("hex");
const now = () => new Date().toISOString();
const atomic = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8"); fs.renameSync(tmp, file); };
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

export function verifyHarnessBinding(binding, { execFile = null } = {}) {
  for (const key of ["harness_repository", "harness_commit_sha", "target_repository", "target_ref", "working_directory", "evidence_root"]) {
    if (typeof binding?.[key] !== "string" || !binding[key]) throw new Error(`binding.${key} required`);
  }
  if (!/^[0-9a-f]{40}$/.test(binding.harness_commit_sha)) throw new Error("harness_commit_sha must be a full SHA");
  if (execFile) {
    const actual = String(execFile(binding.harness_repository, ["rev-parse", binding.harness_commit_sha])).trim();
    if (actual !== binding.harness_commit_sha) throw new Error("HARNESS_COMMIT_MISMATCH");
  }
  return { ...binding };
}

export function createHarnessLauncher({ python = process.env.PYTHON || "python", harnessRoot, launch = null } = {}) {
  if (!harnessRoot) throw new Error("harnessRoot required");
  return async (request) => {
    if (launch) return launch(request);
    const args = ["-m", "codex_ephemeral_harness.cli", "cycle", "--repo", request.target_repository, "--adapter", request.project_adapter || "json", "--mode", "production", "--run-id", request.child_run_id, "--evidence-root", request.evidence_root];
    const env = { ...process.env, PYTHONPATH: path.join(harnessRoot, "src") };
    return await new Promise((resolve, reject) => {
      const child = spawn(python, args, { cwd: request.working_directory, env, windowsHide: true });
      let out = "", err = ""; child.stdout.on("data", (b) => { out += b; }); child.stderr.on("data", (b) => { err += b; });
      child.on("error", reject); child.on("close", (code) => { try { resolve({ exit_code: code, stderr: err, ...JSON.parse(out) }); } catch { reject(new Error(`HARNESS_MALFORMED_OUTPUT:${err || out}`)); } });
    });
  };
}

export function createOuterReceipt({ outer_run_id, binding, file }) {
  const receipt = { schema: OUTER_SCHEMA, outer_run_id, status: "RUNNING", created_at: now(), updated_at: now(), harness_binding: verifyHarnessBinding(binding), cycles: [] };
  if (file) atomic(file, receipt);
  return receipt;
}

function gate(previous, { sourceDrift = false, budgetAvailable = true } = {}) {
  if (!previous) return { action: "CONTINUE", reason: "first_cycle" };
  if (sourceDrift) return { action: "STOP", reason: "SOURCE_DRIFT" };
  if (!budgetAvailable) return { action: "STOP", reason: "BUDGET_EXHAUSTED" };
  const next = previous.next_action || previous.project_next_action;
  return next === "CONTINUE" || next === "localized_retry" ? { action: "CONTINUE", reason: next } : { action: "STOP", reason: next || "NO_NEXT_BOUNDED_WORK" };
}

export async function runOuterCycles({ receiptFile, outer_run_id, binding, project_adapter = "json", goal_identity = "fixture-goal", task_identity = "fixture-task", target_base_sha, working_directory, evidence_root, harnessRoot, launchCycle, maxCycles = 2, sourceDriftCheck = () => false, budgetAvailable = true, crashAfterCycle = null }) {
  let receipt = fs.existsSync(receiptFile) ? readJson(receiptFile) : createOuterReceipt({ outer_run_id, binding, file: receiptFile });
  if (receipt.outer_run_id !== outer_run_id) throw new Error("OUTER_RUN_ID_MISMATCH");
  const launch = launchCycle || createHarnessLauncher({ harnessRoot });
  for (let index = receipt.cycles.length; index < maxCycles; index += 1) {
    const previous = receipt.cycles[index - 1] || null; const decision = gate(previous, { sourceDrift: sourceDriftCheck(), budgetAvailable });
    if (decision.action !== "CONTINUE") { receipt.status = decision.reason === "SOURCE_DRIFT" ? "NEEDS_HUMAN" : "COMPLETE"; receipt.updated_at = now(); atomic(receiptFile, receipt); return { receipt, decision }; }
    const input_state_hash = previous?.resulting_state_hash || sha({ state: "READY", index });
    const dedupe = receipt.cycles.find((c) => c.cycle_index === index && c.input_state_hash === input_state_hash && c.harness_commit_sha === binding.harness_commit_sha);
    if (dedupe) continue;
    const child_run_id = `${outer_run_id}-cycle-${index}`;
    if (sourceDriftCheck()) { receipt.status = "NEEDS_HUMAN"; receipt.updated_at = now(); atomic(receiptFile, receipt); return { receipt, decision: { action: "STOP", reason: "SOURCE_DRIFT" } }; }
    const started_at = now();
    const result = await launch({ outer_run_id, cycle_index: index, child_run_id, harness_repository: binding.harness_repository, harness_commit_sha: binding.harness_commit_sha, target_repository: binding.target_repository, target_base_sha, project_adapter, working_directory, goal_identity, task_identity, expected_previous_state_hash: input_state_hash, evidence_root });
    if (sourceDriftCheck()) { receipt.status = "NEEDS_HUMAN"; receipt.updated_at = now(); atomic(receiptFile, receipt); return { receipt, decision: { action: "STOP", reason: "SOURCE_DRIFT_AFTER_CYCLE" } }; }
    const evidence = result.evidence || result;
    if (evidence.second_cycle && evidence.second_cycle !== "NOT_RUN") throw new Error("HARNESS_SECOND_CYCLE_BOUNDARY_VIOLATION");
    if (evidence.input_state_hash && evidence.input_state_hash !== input_state_hash) throw new Error("INPUT_STATE_HASH_MISMATCH");
    const resulting_state_hash = evidence.resulting_state_hash || sha({ input_state_hash, status: result.status || evidence.status, child_run_id });
    const cycle = { cycle_index: index, child_run_id, harness_commit_sha: binding.harness_commit_sha, target_base_sha, input_state_hash, resulting_state_hash, cycle_evidence_path: result.evidence_path || null, cycle_evidence_hash: result.evidence_path && fs.existsSync(result.evidence_path) ? sha(fs.readFileSync(result.evidence_path)) : sha(evidence), task_id: task_identity, goal_id: goal_identity, fast_path_eligible: evidence.fast_path_eligible === true, skipped_roles: evidence.skipped_roles || [], launched_roles: evidence.launched_roles || [], runner_status: evidence.runner?.status || evidence.runner_status || null, verifier_status: evidence.verifier?.status || evidence.verifier_status || null, next_action: evidence.next_action || (index + 1 < maxCycles ? "localized_retry" : "STOP"), started_at, completed_at: now(), ephemeral: true, transcripts_forwarded: false, role_contexts: evidence.role_contexts || {} };
    receipt.cycles.push(cycle); receipt.updated_at = now(); receipt.status = "RUNNING"; atomic(receiptFile, receipt);
    if (crashAfterCycle === index) throw new Error("SIMULATED_CRASH_AFTER_DURABLE_RECEIPT");
  }
  receipt.status = "COMPLETE"; receipt.updated_at = now(); atomic(receiptFile, receipt); return { receipt, decision: { action: "STOP", reason: "MAX_CYCLES" } };
}

export function dedupeOuterCycle(receipt, key) { return receipt.cycles.find((c) => c.cycle_index === key.cycle_index && c.input_state_hash === key.input_state_hash && c.harness_commit_sha === key.harness_commit_sha) || null; }
