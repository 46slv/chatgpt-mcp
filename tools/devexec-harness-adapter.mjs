import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export const OUTER_SCHEMA = "devexec.harness-outer.v1";

const SHA40 = /^[0-9a-f]{40}$/;
const SHA64 = /^[0-9a-f]{64}$/;
const BINDING_KEYS = [
  "harness_repository",
  "harness_commit_sha",
  "target_repository",
  "target_ref",
  "target_base_sha",
  "working_directory",
  "evidence_root",
];
const TERMINAL = new Set(["COMPLETE", "NEEDS_HUMAN"]);

const sha = (value) => crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : (typeof value === "string" ? value : JSON.stringify(value)), "utf8").digest("hex");
const now = () => new Date().toISOString();
const atomic = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8"); fs.renameSync(tmp, file); };
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const requiredString = (value, label) => { if (typeof value !== "string" || !value) throw new Error(`${label} required`); return value; };

export function verifyHarnessBinding(binding, { execFile = null } = {}) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) throw new Error("binding object required");
  const unknown = Object.keys(binding).filter((key) => !BINDING_KEYS.includes(key));
  if (unknown.length) throw new Error(`binding unknown field:${unknown[0]}`);
  for (const key of BINDING_KEYS) requiredString(binding[key], `binding.${key}`);
  if (!SHA40.test(binding.harness_commit_sha)) throw new Error("harness_commit_sha must be a full SHA");
  if (!SHA40.test(binding.target_base_sha)) throw new Error("target_base_sha must be a full SHA");
  if (execFile) {
    const actual = String(execFile(binding.harness_repository, ["rev-parse", binding.harness_commit_sha])).trim();
    if (actual !== binding.harness_commit_sha) throw new Error("HARNESS_COMMIT_MISMATCH");
  }
  return Object.fromEntries(BINDING_KEYS.map((key) => [key, binding[key]]));
}

function sameBinding(left, right) {
  return BINDING_KEYS.every((key) => left?.[key] === right?.[key]);
}

function verifyRuntimeArguments(binding, { target_base_sha, working_directory, evidence_root } = {}) {
  for (const [key, value] of [["target_base_sha", target_base_sha], ["working_directory", working_directory], ["evidence_root", evidence_root]]) {
    if (value !== undefined && value !== binding[key]) throw new Error(`RUNTIME_BINDING_MISMATCH:${key}`);
  }
}

function validateOuterIdentity({ outer_run_id, goal_identity, task_identity, project_adapter, maxCycles }) {
  requiredString(outer_run_id, "outer_run_id");
  requiredString(goal_identity, "goal_identity");
  requiredString(task_identity, "task_identity");
  requiredString(project_adapter, "project_adapter");
  if (!Number.isInteger(maxCycles) || maxCycles < 1 || maxCycles > 64) throw new Error("maxCycles must be an integer in [1,64]");
}

function validateReceipt(receipt, expected) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error("OUTER_RECEIPT_INVALID");
  if (receipt.schema !== OUTER_SCHEMA) throw new Error("OUTER_SCHEMA_MISMATCH");
  if (receipt.outer_run_id !== expected.outer_run_id) throw new Error("OUTER_RUN_ID_MISMATCH");
  for (const key of ["goal_identity", "task_identity", "project_adapter"]) {
    if (receipt[key] !== expected[key]) throw new Error(`OUTER_IDENTITY_MISMATCH:${key}`);
  }
  if (receipt.max_cycles !== expected.maxCycles) throw new Error("OUTER_IDENTITY_MISMATCH:max_cycles");
  const persistedBinding = verifyHarnessBinding(receipt.harness_binding);
  if (!sameBinding(persistedBinding, expected.binding)) throw new Error("OUTER_BINDING_MISMATCH");
  if (!Array.isArray(receipt.cycles)) throw new Error("OUTER_CYCLES_INVALID");
  if (!new Set(["RUNNING", "COMPLETE", "NEEDS_HUMAN"]).has(receipt.status)) throw new Error("OUTER_STATUS_INVALID");
  for (let index = 0; index < receipt.cycles.length; index += 1) {
    const cycle = receipt.cycles[index];
    if (!cycle || typeof cycle !== "object" || cycle.cycle_index !== index) throw new Error("OUTER_CYCLE_SEQUENCE_INVALID");
    if (cycle.child_run_id !== `${expected.outer_run_id}-cycle-${index}`) throw new Error("OUTER_CHILD_RUN_ID_MISMATCH");
    if (cycle.harness_commit_sha !== expected.binding.harness_commit_sha) throw new Error("OUTER_CYCLE_HARNESS_MISMATCH");
    if (cycle.target_base_sha !== expected.binding.target_base_sha) throw new Error("OUTER_CYCLE_TARGET_MISMATCH");
    if (!SHA64.test(cycle.input_state_hash || "") || !SHA64.test(cycle.resulting_state_hash || "")) throw new Error("OUTER_CYCLE_STATE_HASH_INVALID");
    if (cycle.ephemeral !== true || cycle.transcripts_forwarded !== false) throw new Error("OUTER_CYCLE_EPHEMERAL_INVARIANT_VIOLATION");
    if (Object.hasOwn(cycle, "role_contexts") || Object.hasOwn(cycle, "transcripts")) throw new Error("OUTER_DURABLE_CONTEXT_FORBIDDEN");
  }
  return receipt;
}

export function createHarnessLauncher({ python = process.env.PYTHON || "python", harnessRoot, launch = null } = {}) {
  if (!harnessRoot) throw new Error("harnessRoot required");
  return async (request) => {
    if (launch) return launch(request);
    const args = ["-m", "codex_ephemeral_harness.cli", "cycle", "--repo", request.target_repository, "--adapter", request.project_adapter, "--mode", "production", "--run-id", request.child_run_id, "--evidence-root", request.evidence_root];
    const env = { ...process.env, PYTHONPATH: path.join(harnessRoot, "src") };
    return await new Promise((resolve, reject) => {
      const child = spawn(python, args, { cwd: request.working_directory, env, windowsHide: true });
      let out = "", err = "";
      child.stdout.on("data", (b) => { out += b; });
      child.stderr.on("data", (b) => { err += b; });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) { reject(new Error(`HARNESS_EXIT_NONZERO:${code}`)); return; }
        try { resolve({ exit_code: code, stderr: err, ...JSON.parse(out) }); }
        catch { reject(new Error(`HARNESS_MALFORMED_OUTPUT:${err || out}`)); }
      });
    });
  };
}

export function createOuterReceipt({ outer_run_id, binding, file, goal_identity, task_identity, project_adapter = "json", maxCycles = 2 }) {
  const verifiedBinding = verifyHarnessBinding(binding);
  validateOuterIdentity({ outer_run_id, goal_identity, task_identity, project_adapter, maxCycles });
  const receipt = {
    schema: OUTER_SCHEMA,
    outer_run_id,
    goal_identity,
    task_identity,
    project_adapter,
    max_cycles: maxCycles,
    status: "RUNNING",
    created_at: now(),
    updated_at: now(),
    harness_binding: verifiedBinding,
    cycles: [],
  };
  if (file) atomic(file, receipt);
  return receipt;
}

function gate(previous, { sourceDrift = false, budgetAvailable = true } = {}) {
  if (sourceDrift) return { action: "STOP", reason: "SOURCE_DRIFT" };
  if (!budgetAvailable) return { action: "STOP", reason: "BUDGET_EXHAUSTED" };
  if (!previous) return { action: "CONTINUE", reason: "first_cycle" };
  const next = previous.next_action || previous.project_next_action;
  return next === "CONTINUE" || next === "localized_retry" ? { action: "CONTINUE", reason: next } : { action: "STOP", reason: next || "NO_NEXT_BOUNDED_WORK" };
}

export async function runOuterCycles({ receiptFile, outer_run_id, binding, project_adapter = "json", goal_identity, task_identity, target_base_sha, working_directory, evidence_root, harnessRoot, launchCycle, maxCycles = 2, sourceDriftCheck = () => false, budgetAvailable = true, crashAfterCycle = null }) {
  requiredString(receiptFile, "receiptFile");
  const verifiedBinding = verifyHarnessBinding(binding);
  validateOuterIdentity({ outer_run_id, goal_identity, task_identity, project_adapter, maxCycles });
  verifyRuntimeArguments(verifiedBinding, { target_base_sha, working_directory, evidence_root });
  const expected = { outer_run_id, goal_identity, task_identity, project_adapter, maxCycles, binding: verifiedBinding };
  let receipt = fs.existsSync(receiptFile)
    ? validateReceipt(readJson(receiptFile), expected)
    : createOuterReceipt({ outer_run_id, binding: verifiedBinding, file: receiptFile, goal_identity, task_identity, project_adapter, maxCycles });
  if (TERMINAL.has(receipt.status)) return { receipt, decision: { action: "STOP", reason: "TERMINAL_RECEIPT" } };
  const launch = launchCycle || createHarnessLauncher({ harnessRoot });
  for (let index = receipt.cycles.length; index < maxCycles; index += 1) {
    const previous = receipt.cycles[index - 1] || null;
    const decision = gate(previous, { sourceDrift: sourceDriftCheck(), budgetAvailable });
    if (decision.action !== "CONTINUE") {
      receipt.status = decision.reason === "SOURCE_DRIFT" ? "NEEDS_HUMAN" : "COMPLETE";
      receipt.updated_at = now(); atomic(receiptFile, receipt); return { receipt, decision };
    }
    const input_state_hash = previous?.resulting_state_hash || sha({ schema: OUTER_SCHEMA, outer_run_id, goal_identity, task_identity, project_adapter, binding: verifiedBinding });
    const child_run_id = `${outer_run_id}-cycle-${index}`;
    const started_at = now();
    const result = await launch({
      outer_run_id,
      cycle_index: index,
      child_run_id,
      harness_repository: verifiedBinding.harness_repository,
      harness_commit_sha: verifiedBinding.harness_commit_sha,
      target_repository: verifiedBinding.target_repository,
      target_ref: verifiedBinding.target_ref,
      target_base_sha: verifiedBinding.target_base_sha,
      project_adapter,
      working_directory: verifiedBinding.working_directory,
      goal_identity,
      task_identity,
      expected_previous_state_hash: input_state_hash,
      evidence_root: verifiedBinding.evidence_root,
    });
    if (!result || typeof result !== "object") throw new Error("HARNESS_RESULT_INVALID");
    if (Number.isInteger(result.exit_code) && result.exit_code !== 0) throw new Error(`HARNESS_EXIT_NONZERO:${result.exit_code}`);
    if (sourceDriftCheck()) {
      receipt.status = "NEEDS_HUMAN"; receipt.updated_at = now(); atomic(receiptFile, receipt);
      return { receipt, decision: { action: "STOP", reason: "SOURCE_DRIFT_AFTER_CYCLE" } };
    }
    const evidence = result.evidence || result;
    if (evidence.second_cycle && evidence.second_cycle !== "NOT_RUN") throw new Error("HARNESS_SECOND_CYCLE_BOUNDARY_VIOLATION");
    if (evidence.input_state_hash && evidence.input_state_hash !== input_state_hash) throw new Error("INPUT_STATE_HASH_MISMATCH");
    const resulting_state_hash = evidence.resulting_state_hash || sha({ input_state_hash, status: result.status || evidence.status, child_run_id });
    if (!SHA64.test(resulting_state_hash)) throw new Error("RESULTING_STATE_HASH_INVALID");
    const cycle = {
      cycle_index: index,
      child_run_id,
      harness_commit_sha: verifiedBinding.harness_commit_sha,
      target_base_sha: verifiedBinding.target_base_sha,
      input_state_hash,
      resulting_state_hash,
      cycle_evidence_path: result.evidence_path || null,
      cycle_evidence_hash: result.evidence_path && fs.existsSync(result.evidence_path) ? sha(fs.readFileSync(result.evidence_path)) : sha(evidence),
      task_id: task_identity,
      goal_id: goal_identity,
      fast_path_eligible: evidence.fast_path_eligible === true,
      skipped_roles: evidence.skipped_roles || [],
      launched_roles: evidence.launched_roles || [],
      runner_status: evidence.runner?.status || evidence.runner_status || null,
      verifier_status: evidence.verifier?.status || evidence.verifier_status || null,
      next_action: evidence.next_action || (index + 1 < maxCycles ? "localized_retry" : "STOP"),
      started_at,
      completed_at: now(),
      ephemeral: true,
      transcripts_forwarded: false,
    };
    receipt.cycles.push(cycle); receipt.updated_at = now(); receipt.status = "RUNNING"; atomic(receiptFile, receipt);
    if (crashAfterCycle === index) throw new Error("SIMULATED_CRASH_AFTER_DURABLE_RECEIPT");
  }
  receipt.status = "COMPLETE"; receipt.updated_at = now(); atomic(receiptFile, receipt);
  return { receipt, decision: { action: "STOP", reason: "MAX_CYCLES" } };
}

export function dedupeOuterCycle(receipt, key) {
  return receipt.cycles.find((c) => c.cycle_index === key.cycle_index && c.input_state_hash === key.input_state_hash && c.harness_commit_sha === key.harness_commit_sha) || null;
}
