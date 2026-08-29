import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";

export const TASK_CONTRACT_VERSION = 1;
export const RESULT_CONTRACT_VERSION = 1;
const MAX_GOAL_CHARS = 12000;
const MAX_PATHS = 128;
const MAX_CONSTRAINTS = 64;
const MAX_EVIDENCE_PATHS = 256;
const MAX_RESULT_CHANGED_FILES = 256;
const FORBIDDEN_COMMAND = /(?:^|[^a-z])(git\s+(?:commit|reset|clean|checkout|restore|rebase|push)|(?:rm|del|erase|rmdir|remove-item|format|shutdown|restart-computer)(?:\s|$)|\b(?:curl|wget|invoke-webrequest)\b)/i;
const SHELL_META = /[;&|><`$(){}]/;
const SHELL_EXECUTABLE = /^(?:cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?|bash|sh|zsh|fish)(?:\.exe)?$/i;

export class LocalRuntimeContractError extends Error {
  constructor(message, code = "INVALID_LOCAL_RUNTIME_CONTRACT") {
    super(message);
    this.name = "LocalRuntimeContractError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new LocalRuntimeContractError(message, code);
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value, field, { max = 4096, allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > max) {
    fail(`${field} must be a bounded string`);
  }
  return value;
}

function normalizeRelativePath(value, field = "path") {
  asString(value, field, { max: 1024 });
  if (path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\")) {
    fail(`${field} must be repository-relative`);
  }
  const normalized = value.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length || parts.includes("..") || parts.includes(".")) fail(`${field} escapes the worktree`);
  return parts.join("/");
}

function parseCommandString(value) {
  // Strings are accepted only for simple argv-like commands. Shell syntax is
  // intentionally rejected; callers should prefer an argv array.
  asString(value, "test_command", { max: 2048 });
  if (SHELL_META.test(value) || FORBIDDEN_COMMAND.test(value)) fail("test_command contains forbidden shell syntax", "TEST_COMMAND_DENIED");
  const argv = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s]+)/g;
  let match;
  while ((match = re.exec(value))) argv.push(match[1] ?? match[2] ?? match[3]);
  if (!argv.length) fail("test_command is empty", "TEST_COMMAND_DENIED");
  return argv;
}

export function normalizeTestCommand(value) {
  const fromArray = Array.isArray(value);
  const argv = fromArray ? value.map((arg, i) => asString(arg, `test_command[${i}]`, { max: 1024 })) : parseCommandString(value);
  if (!argv.length || argv.length > 64) fail("test_command must contain 1..64 argv entries", "TEST_COMMAND_DENIED");
  const joined = argv.join(" ");
  // Array argv is executed with shell:false, so metacharacters in a literal
  // interpreter argument (for example `node -e "..."`) are safe. String
  // commands still need the stricter shell-metacharacter check.
  if ((!fromArray && SHELL_META.test(joined)) || FORBIDDEN_COMMAND.test(joined)) fail("test_command contains forbidden syntax", "TEST_COMMAND_DENIED");
  // A shell launched as the test executable defeats shell:false and can
  // reintroduce redirection/command chaining. Direct interpreters (node,
  // python, npm, etc.) remain allowed; callers must pass argv, never a shell.
  if (SHELL_EXECUTABLE.test(path.basename(argv[0]))) fail("test_command shell executable is not allowed", "TEST_COMMAND_DENIED");
  return argv;
}

export function createTaskContract(input) {
  if (!isObject(input)) fail("task contract must be an object");
  const task = {
    version: input.version ?? TASK_CONTRACT_VERSION,
    task_id: input.task_id,
    repo: input.repo,
    worktree: input.worktree ?? input.repo,
    cwd: input.cwd ?? input.worktree ?? input.repo,
    base_commit: input.base_commit,
    goal: input.goal,
    classification: input.classification ?? input.task_classification ?? input.category ?? null,
    allowed_paths: input.allowed_paths ?? [],
    constraints: input.constraints ?? [],
    test_command: input.test_command,
    timeout: input.timeout,
    max_tool_calls: input.max_tool_calls,
    output_limit: input.output_limit,
  };
  validateTaskContract(task, { verifyGit: false });
  return task;
}

export function validateTaskContract(task, { verifyGit = false } = {}) {
  if (!isObject(task) || task.version !== TASK_CONTRACT_VERSION) fail("task.version must be 1");
  const allowedKeys = new Set(["version", "task_id", "repo", "worktree", "cwd", "base_commit", "goal", "classification", "allowed_paths", "constraints", "test_command", "timeout", "max_tool_calls", "output_limit"]);
  const unknownKeys = Object.keys(task).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length) fail(`unknown task fields: ${unknownKeys.join(", ")}`);
  asString(task.task_id, "task_id", { max: 200 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(task.task_id)) fail("task_id contains unsafe characters");
  const repo = path.resolve(asString(task.repo, "repo", { max: 4096 }));
  const worktree = path.resolve(asString(task.worktree, "worktree", { max: 4096 }));
  const cwd = path.resolve(asString(task.cwd ?? task.worktree ?? task.repo, "cwd", { max: 4096 }));
  asString(task.base_commit, "base_commit", { max: 80 });
  if (!/^[0-9a-f]{40}$/i.test(task.base_commit)) fail("base_commit must be a full commit id");
  asString(task.goal, "goal", { max: MAX_GOAL_CHARS });
  validateTaskSuitability(task);
  if (!Array.isArray(task.allowed_paths) || task.allowed_paths.length > MAX_PATHS) fail("allowed_paths must be a bounded array");
  const allowedPaths = task.allowed_paths.map((entry) => normalizeRelativePath(entry, "allowed_paths entry"));
  if (!Array.isArray(task.constraints) || task.constraints.length > MAX_CONSTRAINTS || task.constraints.some((x) => typeof x !== "string" || x.length > 1000)) fail("constraints must be bounded strings");
  const testCommand = normalizeTestCommand(task.test_command);
  for (const [field, min, max] of [["timeout", 1000, 3_600_000], ["max_tool_calls", 1, 100], ["output_limit", 256, 262144]]) {
    if (!Number.isInteger(task[field]) || task[field] < min || task[field] > max) fail(`${field} outside safe bounds`);
  }
  const normalized = { ...task, repo, worktree, cwd, base_commit: task.base_commit.toLowerCase(), goal: task.goal.trim(), allowed_paths: [...new Set(allowedPaths)], test_command: testCommand, constraints: [...task.constraints] };
  if (verifyGit) return { task: normalized, boundary: validateTaskBoundary(normalized) };
  return normalized;
}

const UNSUITABLE_TASK_CLASSIFICATIONS = Object.freeze(new Set([
  "architecture", "authority", "integration", "multi-repo", "multi_repo", "destructive", "final-audit", "final_audit",
]));

/**
 * Local inference is intentionally limited to bounded implementation tasks.
 * Classification is an explicit caller-owned field; this gate never guesses
 * from free-form prose and therefore cannot silently reroute a task.
 */
export function validateTaskSuitability(task) {
  const classification = task?.classification;
  if (classification == null || classification === "") return { suitable: true, classification: null };
  if (typeof classification !== "string" || classification.length > 128) fail("classification must be a bounded string", "TASK_UNSUITABLE");
  const normalized = classification.trim().toLowerCase().replace(/[\s_]+/g, "-");
  const denied = UNSUITABLE_TASK_CLASSIFICATIONS.has(normalized) || ["architecture-", "authority-", "integration-", "multi-repo-", "multi_repository-", "destructive-", "final-audit-"].some((prefix) => normalized.startsWith(prefix));
  if (denied) fail(`task classification is not suitable for local runtime: ${normalized}`, "TASK_UNSUITABLE");
  return { suitable: true, classification: normalized };
}

function runGit(worktree, args) {
  try {
    return execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8", windowsHide: true, timeout: 20000 }).trim();
  } catch (error) {
    fail(`git validation failed: ${String(error?.stderr || error?.message || error)}`, "GIT_VALIDATION_FAILED");
  }
}

function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function rejectReparseSegments(root, relative) {
  const parts = relative.split(/[\\/]+/).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) break;
    let stat;
    try { stat = fs.lstatSync(current); } catch { fail(`cannot inspect allowed path: ${relative}`, "PATH_VALIDATION_FAILED"); }
    if (stat.isSymbolicLink()) fail(`symlink/reparse path is not allowed: ${relative}`, "PATH_REPARSE_REJECTED");
  }
}

export function validateTaskBoundary(task) {
  const normalized = validateTaskContract(task, { verifyGit: false });
  if (!fs.existsSync(normalized.repo) || !fs.statSync(normalized.repo).isDirectory()) fail("repo does not exist", "REPO_NOT_FOUND");
  if (!fs.existsSync(normalized.worktree) || !fs.statSync(normalized.worktree).isDirectory()) fail("worktree does not exist", "WORKTREE_NOT_FOUND");
  const gitRoot = path.resolve(runGit(normalized.worktree, ["rev-parse", "--show-toplevel"]));
  if (!samePath(gitRoot, normalized.worktree) || !samePath(gitRoot, normalized.repo)) fail("repo/worktree must be the exact Git root", "GIT_ROOT_MISMATCH");
  if (!inside(normalized.worktree, normalized.cwd) || !fs.existsSync(normalized.cwd) || !fs.statSync(normalized.cwd).isDirectory()) fail("cwd must be an existing directory inside the Git root", "CWD_INVALID");
  const cwdRelative = path.relative(normalized.worktree, normalized.cwd);
  if (cwdRelative) rejectReparseSegments(normalized.worktree, cwdRelative);
  const baseCommit = runGit(normalized.worktree, ["rev-parse", `${normalized.base_commit}^{commit}`]).toLowerCase();
  if (baseCommit !== normalized.base_commit) fail("base_commit cannot be resolved exactly", "BASE_COMMIT_INVALID");
  const headCommit = runGit(normalized.worktree, ["rev-parse", "HEAD"]).toLowerCase();
  for (const relative of normalized.allowed_paths) {
    const candidate = path.resolve(normalized.worktree, relative);
    if (!inside(normalized.worktree, candidate)) fail(`allowed path escapes worktree: ${relative}`, "PATH_SCOPE_VIOLATION");
    rejectReparseSegments(normalized.worktree, relative);
  }
  return { repo: normalized.repo, worktree: normalized.worktree, git_root: gitRoot, base_commit: baseCommit, head_commit: headCommit, base_matches_head: headCommit === baseCommit };
}

function parseStatusPorcelain(raw) {
  const entries = [];
  for (const record of raw.split("\0")) {
    if (!record) continue;
    const status = record.slice(0, 2);
    const payload = record.slice(3);
    if (status.includes("R") || status.includes("C")) {
      const [oldPath, newPath] = payload.split("\0");
      entries.push(oldPath, newPath);
    } else entries.push(payload);
  }
  return entries.filter(Boolean).map((entry) => entry.replaceAll("\\", "/"));
}

export function captureGitEvidence(worktree, { maxPaths = MAX_EVIDENCE_PATHS } = {}) {
  const root = path.resolve(worktree);
  const head = runGit(root, ["rev-parse", "HEAD"]).toLowerCase();
  const statusRaw = execFileSync("git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=all", "-z"], { encoding: "utf8", windowsHide: true, timeout: 20000 });
  const statusPaths = parseStatusPorcelain(statusRaw);
  const diffRaw = execFileSync("git", ["-C", root, "diff", "HEAD", "--name-only", "--no-renames"], { encoding: "utf8", windowsHide: true, timeout: 20000 });
  const diffPaths = diffRaw.split(/\r?\n/).filter(Boolean).map((x) => x.replaceAll("\\", "/"));
  const allChangedPaths = [...new Set([...statusPaths, ...diffPaths])].sort();
  const bounded = Number.isInteger(maxPaths) && maxPaths > 0 ? maxPaths : MAX_EVIDENCE_PATHS;
  const pathsTruncated = allChangedPaths.length > bounded;
  // Keep evidence bounded, but retain a count so the parent can fail closed
  // instead of accepting an incomplete changed-file claim.
  const changedPaths = allChangedPaths.slice(0, bounded);
  return {
    head_commit: head,
    status_paths: statusPaths.slice(0, bounded),
    diff_paths: diffPaths.slice(0, bounded),
    changed_paths: changedPaths,
    changed_path_count: allChangedPaths.length,
    paths_truncated: pathsTruncated,
    diff_available: allChangedPaths.length > 0,
  };
}

function pathAllowed(relative, allowed) {
  return allowed.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`));
}

export function killProcessTree(child, { platform = process.platform, taskkill = null } = {}) {
  if (!child || !Number.isInteger(child.pid)) return false;
  try {
    if (platform === "win32") {
      const killer = taskkill || ((pid) => execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10000 }));
      killer(child.pid);
    } else {
      try { process.kill(-child.pid, "SIGKILL"); } catch { process.kill(child.pid, "SIGKILL"); }
    }
    return true;
  } catch { return false; }
}

export function runTestCommand(task, { timeoutMs = task.timeout, outputLimit = task.output_limit, spawnImpl = spawn, killTree = killProcessTree, signal } = {}) {
  const argv = normalizeTestCommand(task.test_command);
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawnImpl(argv[0], argv.slice(1), { cwd: task.cwd || task.worktree, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const append = (current, chunk) => {
      const next = current + String(chunk);
      return next.length <= outputLimit ? next : `${next.slice(0, Math.floor(outputLimit / 2))}...[TRUNCATED]...${next.slice(-Math.floor(outputLimit / 2))}`;
    };
    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener?.("abort", onAbort); resolve(value); };
    const onAbort = () => { cancelled = true; killTree(child); };
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    if (signal?.aborted) onAbort(); else signal?.addEventListener?.("abort", onAbort, { once: true });
    child.on("error", (error) => finish({ status: cancelled ? "CANCELLED" : "FAIL", exit_code: null, timed_out: timedOut, cancelled, stdout, stderr: append(stderr, error.message), wall_time_ms: Date.now() - started }));
    child.on("close", (code, closeSignal) => finish({ status: cancelled ? "CANCELLED" : (!timedOut && code === 0 ? "PASS" : "FAIL"), exit_code: code, signal: closeSignal || null, timed_out: timedOut, cancelled, stdout, stderr, wall_time_ms: Date.now() - started }));
  });
}

function normalizeTestEvidence(value, outputLimit) {
  if (!isObject(value) || typeof value.status !== "string") return { status: "FAIL", malformed: true, stdout: "", stderr: "malformed test result" };
  const status = ["PASS", "FAIL", "CANCELLED"].includes(value.status) ? value.status : "FAIL";
  const limit = Number.isInteger(outputLimit) && outputLimit > 0 ? outputLimit : 4000;
  const bound = (entry) => {
    const text = typeof entry === "string" ? entry : entry == null ? "" : String(entry);
    return text.length <= limit ? text : `${text.slice(0, Math.floor(limit / 2))}...[TRUNCATED]...${text.slice(-Math.floor(limit / 2))}`;
  };
  return { ...value, status, stdout: bound(value.stdout), stderr: bound(value.stderr) };
}

export function validateResultContract(result) {
  if (!isObject(result) || result.version !== RESULT_CONTRACT_VERSION) fail("result.version must be 1", "MALFORMED_RESULT");
  asString(result.task_id, "result.task_id", { max: 200 });
  if (!["DONE", "BLOCKED", "FAILED", "CANCELLED"].includes(result.status)) fail("invalid result.status", "MALFORMED_RESULT");
  if (!Array.isArray(result.changed_files) || result.changed_files.length > MAX_RESULT_CHANGED_FILES || result.changed_files.some((x) => typeof x !== "string" || x.length > 1024)) fail("invalid result.changed_files", "MALFORMED_RESULT");
  if (!isObject(result.tests) || !isObject(result.diff_availability) || !isObject(result.runtime_metrics) || !isObject(result.safety_metrics) || !isObject(result.runtime_provider_identity)) fail("result evidence objects are required", "MALFORMED_RESULT");
  if (result.diff_availability.files !== undefined && (!Array.isArray(result.diff_availability.files) || result.diff_availability.files.length > MAX_RESULT_CHANGED_FILES || result.diff_availability.files.some((x) => typeof x !== "string" || x.length > 1024))) fail("invalid result.diff_availability.files", "MALFORMED_RESULT");
  for (const field of ["stdout", "stderr", "blocker"]) if (result.tests[field] !== undefined && (typeof result.tests[field] !== "string" || result.tests[field].length > 262144)) fail(`invalid result.tests.${field}`, "MALFORMED_RESULT");
  if (typeof result.blocker !== "string" || result.blocker.length > 4000) fail("invalid result.blocker", "MALFORMED_RESULT");
  return result;
}

export function redactStructuredLog(value, { maxString = 1000 } = {}) {
  const sensitive = /(?:secret|token|password|authorization|api[_-]?key|cookie|credential|env(?:ironment)?|source[_-]?body|request[_-]?body|response[_-]?body|prompt)/i;
  if (typeof value === "string") {
    const bounded = value.length > maxString ? `${value.slice(0, maxString)}...[TRUNCATED]` : value;
    return bounded.replace(/((?:secret|token|password|api[_-]?key|authorization|cookie|credential)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
  }
  if (Array.isArray(value)) return value.map((entry) => redactStructuredLog(entry, { maxString }));
  if (!isObject(value)) return value;
  const output = {};
  for (const [key, entry] of Object.entries(value)) output[key] = sensitive.test(key) ? "[REDACTED]" : redactStructuredLog(entry, { maxString });
  return output;
}

/**
 * Small deterministic circuit breaker used by bounded retry loops. A second
 * identical failure is enough to stop automatic repetition; callers may still
 * inspect the fingerprint without retaining the potentially sensitive text.
 */
export function createFailureFingerprintGuard({ maxRepeats = 2 } = {}) {
  const limit = Number.isInteger(maxRepeats) && maxRepeats > 0 ? maxRepeats : 2;
  const counts = new Map();
  return Object.freeze({
    record(failure) {
      const text = redactStructuredLog(String(failure?.message || failure || "failure"), { maxString: 2000 }).toLowerCase();
      const fingerprint = crypto.createHash("sha256").update(text).digest("hex");
      const count = (counts.get(fingerprint) || 0) + 1;
      counts.set(fingerprint, count);
      return { fingerprint, count, abort: count >= limit };
    },
    count(fingerprint) { return counts.get(fingerprint) || 0; },
    clear() { counts.clear(); },
  });
}

export function createInferenceAdapter(adapter) {
  if (!adapter || typeof adapter.run !== "function") fail("inference adapter must expose run(task, context)", "ADAPTER_INVALID");
  return Object.freeze({
    identity: isObject(adapter.identity) ? redactStructuredLog(adapter.identity) : { runtime: "local", provider: "unknown" },
    health: typeof adapter.health === "function" ? adapter.health.bind(adapter) : async () => ({ status: "UNKNOWN" }),
    run: adapter.run.bind(adapter),
    stop: typeof adapter.stop === "function" ? adapter.stop.bind(adapter) : async () => {},
  });
}

export async function runLocalWorkerTask(inputTask, { adapter, runTest = runTestCommand, now = () => Date.now(), failureGuard = null, signal = null } = {}) {
  const task = validateTaskContract(inputTask, { verifyGit: false });
  const runtimeAdapter = createInferenceAdapter(adapter);
  const started = now();
  let boundary;
  let before;
  let adapterResult = null;
  let adapterError = null;
  try {
    boundary = validateTaskBoundary(task);
    if (!boundary.base_matches_head) fail("base commit drift before worker start", "BASE_COMMIT_DRIFT");
    before = captureGitEvidence(task.worktree);
  } catch (error) {
    const blocker = redactStructuredLog(String(error?.message || error), { maxString: 4000 });
    const drift = error?.code === "BASE_COMMIT_DRIFT" || error?.code === "BASE_COMMIT_INVALID";
    const result = {
      version: RESULT_CONTRACT_VERSION, task_id: task.task_id, status: "BLOCKED", changed_files: [], tests: { status: "NOT_RUN" }, blocker,
      diff_availability: { available: false, files: [] }, runtime_metrics: { wall_time_ms: now() - started },
      safety_metrics: { preflight: "BLOCKED", base_commit_verified: false, changed_paths_recomputed: true, commit_detected: false, base_drift: drift },
      runtime_provider_identity: runtimeAdapter.identity,
    };
    return { result: validateResultContract(result), log: redactStructuredLog({ event: "local_worker_blocked", task_id: task.task_id, status: result.status, blocker }) };
  }
  try { adapterResult = await runtimeAdapter.run(task, { boundary, before, signal }); } catch (error) { adapterError = error; }
  // A provider crash must not strand an owned process. Adapters are required
  // to make stop() ownership-aware (external engines remain untouched).
  if (adapterError) { try { await runtimeAdapter.stop(); } catch { /* cleanup is best effort */ } }
  let after;
  let postflightError = null;
  try {
    // Re-run the reparse/root checks after provider execution: a worker can
    // create a junction after preflight and then write through it.
    validateTaskBoundary(task);
    after = captureGitEvidence(task.worktree);
  } catch (error) {
    postflightError = error;
    after = { head_commit: before.head_commit, status_paths: [], diff_paths: [], changed_paths: [], changed_path_count: 0, paths_truncated: false, diff_available: false };
  }
  const unexpected = after.changed_paths.filter((relative) => !pathAllowed(relative, task.allowed_paths));
  const evidenceTruncated = !!after.paths_truncated;
  const committed = after.head_commit !== before.head_commit;
  const baseDrift = after.head_commit !== task.base_commit;
  let tests = { status: "NOT_RUN" };
  if (!adapterError && !postflightError && !evidenceTruncated && !unexpected.length && !committed && !baseDrift) {
    try { tests = normalizeTestEvidence(await runTest(task, { signal }), task.output_limit); } catch (error) {
      tests = { status: "FAIL", timed_out: false, cancelled: false, stdout: "", stderr: redactStructuredLog(String(error?.message || error), { maxString: task.output_limit }), wall_time_ms: 0 };
    }
  }
  let status = "DONE";
  let blocker = "none";
  let failureFingerprint = null;
  if (adapterError) {
    status = "FAILED";
    blocker = redactStructuredLog(String(adapterError?.message || adapterError), { maxString: 4000 });
    if (failureGuard?.record) {
      const repeat = failureGuard.record(adapterError);
      failureFingerprint = repeat.fingerprint;
      if (repeat.abort) { status = "BLOCKED"; blocker = "duplicate failure fingerprint threshold reached"; }
    }
  }
  else if (postflightError) { status = "BLOCKED"; blocker = redactStructuredLog(String(postflightError?.message || postflightError), { maxString: 4000 }); }
  else if (evidenceTruncated) { status = "BLOCKED"; blocker = `changed-file evidence exceeds ${MAX_EVIDENCE_PATHS} paths`; }
  else if (unexpected.length) { status = "BLOCKED"; blocker = `unexpected changed paths: ${unexpected.join(", ")}`; }
  else if (committed) { status = "BLOCKED"; blocker = "worker commit detected; local worker must not commit"; }
  else if (baseDrift) { status = "BLOCKED"; blocker = "base commit drift detected"; }
  else if (!adapterResult || typeof adapterResult !== "object" || typeof adapterResult.status !== "string") { status = "FAILED"; blocker = "malformed local worker provider result"; }
  else if (adapterResult && typeof adapterResult.status === "string" && !["PASS", "DONE", "SUCCESS"].includes(adapterResult.status)) {
    status = adapterResult.status === "BLOCKED" ? "BLOCKED" : adapterResult.status === "CANCELLED" ? "CANCELLED" : "FAILED";
    blocker = adapterResult.status === "BLOCKED" ? "local worker provider blocked" : "local worker reported runtime failure";
  }
  else if (tests.status !== "PASS") { status = tests.status === "CANCELLED" || tests.cancelled ? "CANCELLED" : "FAILED"; blocker = tests.timed_out ? "test timeout" : tests.cancelled ? "test cancelled" : "tests did not pass"; }
  const result = {
    version: RESULT_CONTRACT_VERSION, task_id: task.task_id, status, changed_files: after.changed_paths, tests, blocker,
    diff_availability: { available: after.diff_available, files: after.diff_paths },
    runtime_metrics: { wall_time_ms: now() - started, adapter_status: typeof adapterResult?.status === "string" ? adapterResult.status : "UNTRUSTED", failure_fingerprint: failureFingerprint },
    safety_metrics: { preflight: "PASS", postflight: postflightError ? "BLOCKED" : "PASS", base_commit_verified: true, changed_paths_recomputed: true, unexpected_changes: unexpected, commit_detected: committed, base_drift: baseDrift, evidence_truncated: evidenceTruncated, result_claim_trusted: false },
    runtime_provider_identity: runtimeAdapter.identity,
  };
  const log = redactStructuredLog({ event: "local_worker_result", task_id: task.task_id, status, changed_files: after.changed_paths, tests: { status: tests.status, exit_code: tests.exit_code ?? null }, blocker, runtime_provider_identity: runtimeAdapter.identity, wall_time_ms: result.runtime_metrics.wall_time_ms });
  return { result: validateResultContract(result), log };
}

export const LOCAL_RUNTIME_KIND = "minimal-harness-inference-adapter";
