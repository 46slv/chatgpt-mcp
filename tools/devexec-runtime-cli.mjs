#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createFreeTokenInferenceAdapter } from "./freetoken-inference-adapter.mjs";
import { createDevExecEntrypoint, resolveDevExecRuntimeSelection } from "./devexec-runtime-selector.mjs";
import { RESULT_CONTRACT_VERSION, validateTaskContract, redactStructuredLog } from "./local-worker-runtime.mjs";
import { summarizeLocalRunRecords } from "./local-run-ledger.mjs";

const MAX_TASK_FILE_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 512 * 1024;
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function boundedString(value, name, max = 4096) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} must be a bounded string`);
  return value.trim();
}

function safeText(value, max = 1000) {
  return redactStructuredLog(typeof value === "string" ? value.slice(0, max) : String(value ?? ""), { maxString: max });
}

function identityFor(selection, model = null) {
  return {
    runtime: selection?.runtime || "default",
    provider: selection?.provider || "existing",
    ...(model ? { model: safeText(model, 256) } : {}),
  };
}

function blockedResult(taskId, blocker, identity = { runtime: "default", provider: "existing" }) {
  return {
    version: RESULT_CONTRACT_VERSION,
    task_id: SAFE_TASK_ID.test(String(taskId || "")) ? String(taskId) : "unknown",
    status: "BLOCKED",
    changed_files: [],
    tests: { status: "NOT_RUN", evidence_valid: false },
    blocker: safeText(blocker, 4000),
    diff_availability: { available: false, files: [] },
    runtime_metrics: { wall_time_ms: 0, adapter_status: "NOT_RUN" },
    safety_metrics: { preflight: "BLOCKED", postflight: "NOT_RUN", base_commit_verified: false, changed_paths_recomputed: false, commit_detected: false, base_drift: false, result_claim_trusted: false },
    runtime_provider_identity: identityFor(identity, identity?.model),
  };
}

function publicResult(result) {
  const tests = result?.tests || {};
  const safeTests = { status: typeof tests.status === "string" ? tests.status : "NOT_RUN", evidence_valid: tests.evidence_valid === true };
  for (const key of ["exit_code", "wall_time_ms"]) if (Number.isFinite(tests[key])) safeTests[key] = tests[key];
  for (const key of ["timed_out", "cancelled", "malformed", "invalid_evidence"]) if (typeof tests[key] === "boolean") safeTests[key] = tests[key];
  const safeIdentity = {};
  for (const key of ["runtime", "provider", "model", "device_index"]) {
    const value = result?.runtime_provider_identity?.[key];
    if (typeof value === "string" || Number.isInteger(value)) safeIdentity[key] = typeof value === "string" ? safeText(value, 256) : value;
  }
  const ledger = result?.ledger && typeof result.ledger === "object" ? result.ledger : { status: "NOT_ATTEMPTED", code: null, path: null };
  const ledgerStatus = ["WRITTEN", "FAILED", "NOT_ATTEMPTED"].includes(ledger.status) ? ledger.status : "FAILED";
  const ledgerPath = typeof ledger.path === "string" && !/[\\/]/.test(ledger.path) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(ledger.path) ? ledger.path : null;
  return redactStructuredLog({
    version: RESULT_CONTRACT_VERSION,
    run_id: String(result?.run_id || "unknown").slice(0, 200),
    task_id: String(result?.task_id || "unknown").slice(0, 200),
    status: ["DONE", "BLOCKED", "FAILED", "CANCELLED"].includes(result?.status) ? result.status : "FAILED",
    changed_files: Array.isArray(result?.changed_files) ? result.changed_files.slice(0, 256).map((x) => String(x).slice(0, 1024)) : [],
    tests: safeTests,
    blocker: safeText(result?.blocker || "none", 4000),
    diff_availability: { available: result?.diff_availability?.available === true, files: Array.isArray(result?.diff_availability?.files) ? result.diff_availability.files.slice(0, 256).map((x) => String(x).slice(0, 1024)) : [] },
    runtime_metrics: redactStructuredLog(result?.runtime_metrics || {}, { maxString: 256 }),
    safety_metrics: redactStructuredLog(result?.safety_metrics || {}, { maxString: 256 }),
    runtime_provider_identity: safeIdentity,
    ledger: { status: ledgerStatus, code: typeof ledger.code === "string" ? safeText(ledger.code, 128) : null, path: ledgerPath },
  }, { maxString: 4000 });
}

function atomicWrite(file, value) {
  const target = path.resolve(boundedString(file, "output path", 4096));
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const encoded = JSON.stringify(value, null, 2) + "\n";
  if (Buffer.byteLength(encoded, "utf8") > MAX_OUTPUT_BYTES) throw new Error("output exceeds evidence limit");
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, encoded, { encoding: "utf8", flag: "wx" });
  try { fs.renameSync(temporary, target); } catch (error) { try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ } throw error; }
  return target;
}

function loadTaskFile(file) {
  const requested = boundedString(file, "task path", 4096);
  const target = path.resolve(requested);
  let stat;
  try { stat = fs.lstatSync(target); } catch { throw new Error("task file not found"); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("task path must be a regular file");
  if (stat.size > MAX_TASK_FILE_BYTES) throw new Error(`task file exceeds ${MAX_TASK_FILE_BYTES} bytes`);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(target, "utf8")); } catch { throw new Error("task file is not valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("task JSON must be an object");
  // validateTaskContract owns the version and unknown-field allowlist. Do not
  // use createTaskContract here: it intentionally projects fields and would
  // hide a typo in a user-supplied TaskContract file.
  return validateTaskContract(parsed, { verifyGit: false });
}

async function loadInjectedAdapter(modulePath, context) {
  const requested = boundedString(modulePath, "adapter module", 4096);
  const target = path.resolve(requested);
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("adapter module must be a regular file");
  const imported = await import(pathToFileURL(target).href);
  const candidate = imported.createAdapter || imported.default || imported.adapter;
  const adapter = typeof candidate === "function" ? await candidate(context) : candidate;
  if (!adapter || typeof adapter.run !== "function") throw new Error("injected adapter must expose run(task, context)");
  return adapter;
}

function defaultEvidencePath(taskId) {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const id = SAFE_TASK_ID.test(String(taskId || "")) ? taskId : "unknown";
  return path.join(base, "ChatGPTMCPProbe", "devexec-runtime-evidence", `${id}-${Date.now()}.json`);
}

function defaultLedgerDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "ChatGPTMCPProbe", "devexec-local-run-ledger");
}

function flagValue(args, names) {
  const wanted = new Set(names);
  for (let i = 0; i < args.length - 1; i += 1) if (wanted.has(args[i])) return args[i + 1];
  return null;
}

export function exitCodeForResult(result) {
  if (result?.status === "DONE") return 0;
  if (result?.status === "FAILED") return 1;
  if (result?.status === "CANCELLED") return 130;
  return 2;
}

async function runTask(args) {
  const selection = {};
  let taskPath = null;
  let evidencePath = null;
  let outputPath = null;
  let adapterModule = null;
  let ledgerDir = null;
  const freetoken = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (["--runtime", "--provider", "--task", "--evidence", "--log", "--output", "--adapter-module", "--model", "--model-path", "--control-url", "--serve-url", "--ledger-dir"].includes(arg)) {
      const value = args[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--runtime" || arg === "--provider") selection[arg.slice(2)] = value;
      else if (arg === "--task") taskPath = value;
      else if (arg === "--evidence" || arg === "--log") evidencePath = value;
      else if (arg === "--output") outputPath = value;
      else if (arg === "--adapter-module") adapterModule = value;
      else if (arg === "--ledger-dir") ledgerDir = value;
      else if (arg === "--model") freetoken.model = value;
      else if (arg === "--model-path") freetoken.modelPath = value;
      else if (arg === "--control-url") freetoken.controlUrl = value;
      else if (arg === "--serve-url") freetoken.serveUrl = value;
    } else if (arg === "--enabled") selection.enabled = true;
    else if (arg === "--disabled") selection.enabled = false;
    else throw new Error(`Unknown runtime argument: ${arg}`);
  }
  if (!taskPath) throw new Error("runtime run requires --task <path>");
  const task = loadTaskFile(taskPath);
  let selected;
  try { selected = resolveDevExecRuntimeSelection(selection, process.env); }
  catch (error) {
    const result = blockedResult(task.task_id, error?.message || error);
    const publicValue = publicResult(result);
    atomicWrite(evidencePath || defaultEvidencePath(task.task_id), { protocol: "devexec.runtime.evidence", schema_version: 1, result: publicValue, log: { event: "runtime_selection_blocked", task_id: task.task_id, status: publicValue.status, blocker: publicValue.blocker } });
    if (outputPath) atomicWrite(outputPath, publicValue);
    process.stdout.write(`${JSON.stringify(publicValue, null, 2)}\n`);
    return exitCodeForResult(publicValue);
  }
  // A missing selector is deliberately a no-op. This keeps the established
  // cloud/default path untouched and makes accidental local execution impossible.
  if (selected.runtime !== "local" || selected.provider !== "freetoken" || selected.enabled !== true) {
    const result = blockedResult(task.task_id, "explicit local FreeToken runtime is required; local execution was not started", selected);
    const publicValue = publicResult(result);
    atomicWrite(evidencePath || defaultEvidencePath(task.task_id), { protocol: "devexec.runtime.evidence", schema_version: 1, result: publicValue, log: { event: "runtime_not_enabled", task_id: task.task_id, status: publicValue.status, blocker: publicValue.blocker, runtime_provider_identity: publicValue.runtime_provider_identity } });
    if (outputPath) atomicWrite(outputPath, publicValue);
    process.stdout.write(`${JSON.stringify(publicValue, null, 2)}\n`);
    return exitCodeForResult(publicValue);
  }

  let adapter;
  try {
    adapter = adapterModule
      ? await loadInjectedAdapter(adapterModule, { task, selection: selected })
      : createFreeTokenInferenceAdapter({ config: { enabled: true, ...freetoken }, env: process.env, log: () => {} });
  } catch (error) {
    const result = blockedResult(task.task_id, error?.message || error, identityFor(selected, freetoken.model || process.env.FREETOKEN_MODEL || null));
    const publicValue = publicResult(result);
    atomicWrite(evidencePath || defaultEvidencePath(task.task_id), { protocol: "devexec.runtime.evidence", schema_version: 1, result: publicValue, log: { event: "runtime_adapter_unavailable", task_id: task.task_id, status: publicValue.status, blocker: publicValue.blocker, runtime_provider_identity: publicValue.runtime_provider_identity } });
    if (outputPath) atomicWrite(outputPath, publicValue);
    process.stdout.write(`${JSON.stringify(publicValue, null, 2)}\n`);
    return exitCodeForResult(publicValue);
  }
  const entrypoint = createDevExecEntrypoint({ selection: selected, adapters: { freetoken: adapter }, freetoken });
  const abort = new AbortController();
  const onSignal = () => abort.abort(new Error("cancelled by caller"));
  process.once("SIGINT", onSignal);
  let outcome;
  try { outcome = await entrypoint.run(task, { signal: abort.signal, runLedgerDir: ledgerDir || defaultLedgerDir(), selection: selected }); }
  finally { process.removeListener("SIGINT", onSignal); }
  const rawResult = outcome?.result ? { ...outcome.result, ...(outcome.run_id ? { run_id: outcome.run_id } : {}), ...(outcome.ledger ? { ledger: outcome.ledger } : {}) } : blockedResult(task.task_id, "runtime returned no result", identityFor(selected, freetoken.model || null));
  const publicValue = publicResult(rawResult);
  const log = redactStructuredLog({ event: "runtime_result", task_id: publicValue.task_id, status: publicValue.status, blocker: publicValue.blocker, changed_files: publicValue.changed_files, tests: { status: publicValue.tests.status, exit_code: publicValue.tests.exit_code ?? null }, runtime_provider_identity: publicValue.runtime_provider_identity, runtime_metrics: publicValue.runtime_metrics }, { maxString: 1000 });
  atomicWrite(evidencePath || defaultEvidencePath(task.task_id), { protocol: "devexec.runtime.evidence", schema_version: 1, result: publicValue, log });
  if (outputPath) atomicWrite(outputPath, publicValue);
  process.stdout.write(`${JSON.stringify(publicValue, null, 2)}\n`);
  return exitCodeForResult(publicValue);
}

function usage() {
 process.stderr.write("Usage: devexec runtime select [--runtime <default|cloud|local>] [--provider <existing|chatgpt|lmstudio|freetoken>] [--enabled|--disabled]\n");
 process.stderr.write("       devexec runtime run --task <TaskContract.json> --runtime local --provider freetoken [--enabled|--disabled] [--evidence <path>] [--output <path>]\n");
 process.stderr.write("       devexec runtime metrics summarize <ledger-dir>\n");
}
const args = process.argv.slice(2);
const command = args.shift();
if (command === "select") {
  const selection = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--runtime" || arg === "--provider") {
      const value = args[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      selection[arg.slice(2)] = value;
    } else if (arg === "--enabled") selection.enabled = true;
    else if (arg === "--disabled") selection.enabled = false;
    else throw new Error(`Unknown runtime argument: ${arg}`);
  }
  try { process.stdout.write(`${JSON.stringify(resolveDevExecRuntimeSelection(selection), null, 2)}\n`); process.exitCode = 0; }
  catch (error) { process.stderr.write(`${String(error?.message || error)}\n`); process.exitCode = 2; }
}
else if (command === "run") {
  try { process.exitCode = await runTask(args); }
  catch (error) {
    const result = publicResult(blockedResult("unknown", error?.message || error));
    const evidencePath = flagValue(args, ["--evidence", "--log"]);
    const outputPath = flagValue(args, ["--output"]);
    try { atomicWrite(evidencePath || defaultEvidencePath("unknown"), { protocol: "devexec.runtime.evidence", schema_version: 1, result, log: { event: "runtime_input_blocked", task_id: result.task_id, status: result.status, blocker: result.blocker } }); } catch { /* keep stdout truthful even when the requested evidence path is unavailable */ }
    try { if (outputPath) atomicWrite(outputPath, result); } catch { /* output is optional */ }
    try { process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); } catch { process.stderr.write("runtime run failed\n"); }
    process.exitCode = exitCodeForResult(result);
  }
}
else if (command === "metrics") {
  const subcommand = args.shift();
  if (subcommand !== "summarize" || args.length !== 1) { usage(); process.exitCode = 2; }
  else {
    try { process.stdout.write(`${JSON.stringify(summarizeLocalRunRecords(args[0]), null, 2)}\n`); process.exitCode = 0; }
    catch (error) { process.stderr.write(`${safeText(error?.message || error, 1000)}\n`); process.exitCode = 2; }
  }
}
else { usage(); process.exitCode = 2; }
