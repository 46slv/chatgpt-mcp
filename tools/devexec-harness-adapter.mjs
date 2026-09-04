import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

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
const RECEIPT_KEYS = [
  "schema",
  "outer_run_id",
  "goal_identity",
  "task_identity",
  "project_adapter",
  "max_cycles",
  "status",
  "created_at",
  "updated_at",
  "harness_binding",
  "cycles",
];
const CYCLE_KEYS = [
  "cycle_index",
  "child_run_id",
  "harness_commit_sha",
  "target_base_sha",
  "input_state_hash",
  "resulting_state_hash",
  "cycle_evidence_path",
  "cycle_evidence_hash",
  "task_id",
  "goal_id",
  "fast_path_eligible",
  "skipped_roles",
  "launched_roles",
  "runner_status",
  "verifier_status",
  "next_action",
  "started_at",
  "completed_at",
  "ephemeral",
  "transcripts_forwarded",
];
const TERMINAL = new Set(["COMPLETE", "NEEDS_HUMAN"]);
const STATUS_VALUES = new Set(["RUNNING", "COMPLETE", "NEEDS_HUMAN"]);

const sha = (value) => crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : (typeof value === "string" ? value : JSON.stringify(value)), "utf8").digest("hex");
const now = () => new Date().toISOString();
const atomic = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8"); fs.renameSync(tmp, file); };
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const requiredString = (value, label) => { if (typeof value !== "string" || !value) throw new Error(`${label} required`); return value; };
const requireObject = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}_INVALID`);
  return value;
};
const rejectUnknown = (value, allowed, label) => {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label}_UNKNOWN_FIELD:${unknown[0]}`);
};
const requireFields = (value, required, label) => {
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`${label}_REQUIRED_FIELD_MISSING:${key}`);
};
const requireDateTime = (value, label) => {
  requiredString(value, label);
  if (Number.isNaN(Date.parse(value))) throw new Error(`${label}_INVALID`);
};
const requireStringArray = (value, label) => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label}_INVALID`);
};
const requireNullableString = (value, label) => {
  if (value !== null && typeof value !== "string") throw new Error(`${label}_INVALID`);
};

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

function validateCycle(cycle, index, expected) {
  requireObject(cycle, "OUTER_CYCLE");
  rejectUnknown(cycle, CYCLE_KEYS, "OUTER_CYCLE");
  requireFields(cycle, CYCLE_KEYS, "OUTER_CYCLE");

  if (!Number.isInteger(cycle.cycle_index) || cycle.cycle_index < 0 || cycle.cycle_index > 63 || cycle.cycle_index !== index) {
    throw new Error("OUTER_CYCLE_SEQUENCE_INVALID");
  }
  requiredString(cycle.child_run_id, "cycle.child_run_id");
  if (cycle.child_run_id !== `${expected.outer_run_id}-cycle-${index}`) throw new Error("OUTER_CHILD_RUN_ID_MISMATCH");
  if (!SHA40.test(cycle.harness_commit_sha || "") || cycle.harness_commit_sha !== expected.binding.harness_commit_sha) {
    throw new Error("OUTER_CYCLE_HARNESS_MISMATCH");
  }
  if (!SHA40.test(cycle.target_base_sha || "") || cycle.target_base_sha !== expected.binding.target_base_sha) {
    throw new Error("OUTER_CYCLE_TARGET_MISMATCH");
  }
  if (!SHA64.test(cycle.input_state_hash || "") || !SHA64.test(cycle.resulting_state_hash || "")) throw new Error("OUTER_CYCLE_STATE_HASH_INVALID");
  if (cycle.cycle_evidence_path !== null && typeof cycle.cycle_evidence_path !== "string") throw new Error("OUTER_CYCLE_EVIDENCE_PATH_INVALID");
  if (!SHA64.test(cycle.cycle_evidence_hash || "")) throw new Error("OUTER_CYCLE_EVIDENCE_HASH_INVALID");
  requiredString(cycle.task_id, "cycle.task_id");
  requiredString(cycle.goal_id, "cycle.goal_id");
  if (cycle.task_id !== expected.task_identity) throw new Error("OUTER_CYCLE_TASK_ID_MISMATCH");
  if (cycle.goal_id !== expected.goal_identity) throw new Error("OUTER_CYCLE_GOAL_ID_MISMATCH");
  if (typeof cycle.fast_path_eligible !== "boolean") throw new Error("OUTER_CYCLE_FAST_PATH_INVALID");
  requireStringArray(cycle.skipped_roles, "OUTER_CYCLE_SKIPPED_ROLES");
  requireStringArray(cycle.launched_roles, "OUTER_CYCLE_LAUNCHED_ROLES");
  requireNullableString(cycle.runner_status, "OUTER_CYCLE_RUNNER_STATUS");
  requireNullableString(cycle.verifier_status, "OUTER_CYCLE_VERIFIER_STATUS");
  requiredString(cycle.next_action, "cycle.next_action");
  requireDateTime(cycle.started_at, "OUTER_CYCLE_STARTED_AT");
  requireDateTime(cycle.completed_at, "OUTER_CYCLE_COMPLETED_AT");
  if (cycle.ephemeral !== true || cycle.transcripts_forwarded !== false) throw new Error("OUTER_CYCLE_EPHEMERAL_INVARIANT_VIOLATION");
}

function validateReceipt(receipt, expected) {
  requireObject(receipt, "OUTER_RECEIPT");
  rejectUnknown(receipt, RECEIPT_KEYS, "OUTER_RECEIPT");
  requireFields(receipt, RECEIPT_KEYS, "OUTER_RECEIPT");

  if (receipt.schema !== OUTER_SCHEMA) throw new Error("OUTER_SCHEMA_MISMATCH");
  requiredString(receipt.outer_run_id, "outer_run_id");
  if (receipt.outer_run_id !== expected.outer_run_id) throw new Error("OUTER_RUN_ID_MISMATCH");
  for (const key of ["goal_identity", "task_identity", "project_adapter"]) {
    requiredString(receipt[key], key);
    if (receipt[key] !== expected[key]) throw new Error(`OUTER_IDENTITY_MISMATCH:${key}`);
  }
  if (!Number.isInteger(receipt.max_cycles) || receipt.max_cycles < 1 || receipt.max_cycles > 64) throw new Error("OUTER_MAX_CYCLES_INVALID");
  if (receipt.max_cycles !== expected.maxCycles) throw new Error("OUTER_IDENTITY_MISMATCH:max_cycles");
  if (!STATUS_VALUES.has(receipt.status)) throw new Error("OUTER_STATUS_INVALID");
  requireDateTime(receipt.created_at, "OUTER_CREATED_AT");
  requireDateTime(receipt.updated_at, "OUTER_UPDATED_AT");

  const persistedBinding = verifyHarnessBinding(receipt.harness_binding);
  if (!sameBinding(persistedBinding, expected.binding)) throw new Error("OUTER_BINDING_MISMATCH");
  if (!Array.isArray(receipt.cycles)) throw new Error("OUTER_CYCLES_INVALID");
  if (receipt.cycles.length > receipt.max_cycles || receipt.cycles.length > 64) throw new Error("OUTER_CYCLE_COUNT_EXCEEDS_MAX");
  for (let index = 0; index < receipt.cycles.length; index += 1) validateCycle(receipt.cycles[index], index, expected);
  return receipt;
}

export function createHarnessLauncher({ python = process.env.PYTHON || "python", harnessRoot, launch = null, resolveHarnessCommit = null } = {}) {
  if (!harnessRoot) throw new Error("harnessRoot required");
  const resolveCommit = resolveHarnessCommit || ((root) => execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }));
  return async (request) => {
    if (path.resolve(harnessRoot) !== path.resolve(request.harness_repository)) throw new Error("HARNESS_REPOSITORY_PATH_MISMATCH");
    const actualCommit = String(resolveCommit(harnessRoot)).trim();
    if (actualCommit !== request.harness_commit_sha) throw new Error("HARNESS_COMMIT_MISMATCH");
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

function hashCycleEvidence(evidencePath, evidence, evidenceRoot) {
  if (evidencePath === undefined || evidencePath === null) return { path: null, hash: sha(evidence) };
  if (typeof evidencePath !== "string" || !evidencePath) throw new Error("EVIDENCE_PATH_INVALID");
  const lexicalRoot = path.resolve(evidenceRoot);
  const lexicalResolved = path.resolve(lexicalRoot, evidencePath);
  const lexicalRelative = path.relative(lexicalRoot, lexicalResolved);
  if (lexicalRelative === "" || lexicalRelative.startsWith(`..${path.sep}`) || lexicalRelative === ".." || path.isAbsolute(lexicalRelative)) throw new Error("EVIDENCE_PATH_OUTSIDE_ROOT");
  const root = fs.realpathSync(lexicalRoot);
  const resolved = fs.realpathSync(lexicalResolved);
  const relative = path.relative(root, resolved);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("EVIDENCE_PATH_OUTSIDE_ROOT");
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error("EVIDENCE_PATH_NOT_FILE");
  if (stat.size > 8 * 1024 * 1024) throw new Error("EVIDENCE_FILE_TOO_LARGE");
  return { path: relative.split(path.sep).join("/"), hash: sha(fs.readFileSync(resolved)) };
}

function gate(previous, { sourceDrift = false, budgetAvailable = true } = {}) {
  if (sourceDrift) return { action: "STOP", reason: "SOURCE_DRIFT" };
  if (!budgetAvailable) return { action: "STOP", reason: "BUDGET_EXHAUSTED" };
  if (!previous) return { action: "CONTINUE", reason: "first_cycle" };
  const next = previous.next_action;
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
    requireObject(result, "HARNESS_RESULT");
    if (Object.hasOwn(result, "exit_code") && result.exit_code !== 0) throw new Error(`HARNESS_EXIT_NONZERO:${result.exit_code}`);
    if (sourceDriftCheck()) {
      receipt.status = "NEEDS_HUMAN"; receipt.updated_at = now(); atomic(receiptFile, receipt);
      return { receipt, decision: { action: "STOP", reason: "SOURCE_DRIFT_AFTER_CYCLE" } };
    }
    const evidence = Object.hasOwn(result, "evidence") ? requireObject(result.evidence, "HARNESS_EVIDENCE") : result;
    if (Object.hasOwn(evidence, "second_cycle") && evidence.second_cycle !== "NOT_RUN") throw new Error("HARNESS_SECOND_CYCLE_BOUNDARY_VIOLATION");
    if (Object.hasOwn(evidence, "input_state_hash") && evidence.input_state_hash !== input_state_hash) throw new Error("INPUT_STATE_HASH_MISMATCH");
    const resulting_state_hash = Object.hasOwn(evidence, "resulting_state_hash")
      ? evidence.resulting_state_hash
      : sha({ input_state_hash, status: result.status || evidence.status, child_run_id });
    if (typeof resulting_state_hash !== "string" || !SHA64.test(resulting_state_hash)) throw new Error("RESULTING_STATE_HASH_INVALID");
    if (Object.hasOwn(evidence, "runner")) requireObject(evidence.runner, "HARNESS_RUNNER");
    if (Object.hasOwn(evidence, "verifier")) requireObject(evidence.verifier, "HARNESS_VERIFIER");
    const cycleEvidence = hashCycleEvidence(Object.hasOwn(result, "evidence_path") ? result.evidence_path : undefined, evidence, verifiedBinding.evidence_root);
    const cycle = {
      cycle_index: index,
      child_run_id,
      harness_commit_sha: verifiedBinding.harness_commit_sha,
      target_base_sha: verifiedBinding.target_base_sha,
      input_state_hash,
      resulting_state_hash,
      cycle_evidence_path: cycleEvidence.path,
      cycle_evidence_hash: cycleEvidence.hash,
      task_id: task_identity,
      goal_id: goal_identity,
      fast_path_eligible: Object.hasOwn(evidence, "fast_path_eligible") ? evidence.fast_path_eligible : false,
      skipped_roles: Object.hasOwn(evidence, "skipped_roles") ? evidence.skipped_roles : [],
      launched_roles: Object.hasOwn(evidence, "launched_roles") ? evidence.launched_roles : [],
      runner_status: Object.hasOwn(evidence, "runner") && Object.hasOwn(evidence.runner, "status") ? evidence.runner.status : (Object.hasOwn(evidence, "runner_status") ? evidence.runner_status : null),
      verifier_status: Object.hasOwn(evidence, "verifier") && Object.hasOwn(evidence.verifier, "status") ? evidence.verifier.status : (Object.hasOwn(evidence, "verifier_status") ? evidence.verifier_status : null),
      next_action: Object.hasOwn(evidence, "next_action") ? evidence.next_action : (index + 1 < maxCycles ? "localized_retry" : "STOP"),
      started_at,
      completed_at: now(),
      ephemeral: true,
      transcripts_forwarded: false,
    };
    validateCycle(cycle, index, expected);
    const nextReceipt = {
      ...receipt,
      cycles: [...receipt.cycles, cycle],
      updated_at: now(),
      status: "RUNNING",
    };
    validateReceipt(nextReceipt, expected);
    receipt = nextReceipt;
    atomic(receiptFile, receipt);
    if (crashAfterCycle === index) throw new Error("SIMULATED_CRASH_AFTER_DURABLE_RECEIPT");
  }
  receipt.status = "COMPLETE"; receipt.updated_at = now(); atomic(receiptFile, receipt);
  return { receipt, decision: { action: "STOP", reason: "MAX_CYCLES" } };
}

export function dedupeOuterCycle(receipt, key) {
  return receipt.cycles.find((c) => c.cycle_index === key.cycle_index && c.input_state_hash === key.input_state_hash && c.harness_commit_sha === key.harness_commit_sha) || null;
}
