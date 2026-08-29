import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

export const TASK_CONTRACT_VERSION = 1;
export const RESULT_CONTRACT_VERSION = 1;
const MAX_GOAL_CHARS = 12000;
const MAX_PATHS = 128;
const MAX_CONSTRAINTS = 64;
const FORBIDDEN_COMMAND = /(?:^|[^a-z])(git\s+(?:commit|reset|clean|checkout|restore|rebase|push)|(?:rm|del|erase|rmdir|remove-item|format|shutdown|restart-computer)(?:\s|$)|\b(?:curl|wget|invoke-webrequest)\b)/i;
const SHELL_META = /[;&|><`$(){}]/;

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
  const allowedKeys = new Set(["version", "task_id", "repo", "worktree", "cwd", "base_commit", "goal", "allowed_paths", "constraints", "test_command", "timeout", "max_tool_calls", "output_limit"]);
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

export function captureGitEvidence(worktree) {
  const root = path.resolve(worktree);
  const head = runGit(root, ["rev-parse", "HEAD"]).toLowerCase();
  const statusRaw = execFileSync("git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=all", "-z"], { encoding: "utf8", windowsHide: true, timeout: 20000 });
  const statusPaths = parseStatusPorcelain(statusRaw);
  const diffRaw = execFileSync("git", ["-C", root, "diff", "HEAD", "--name-only", "--no-renames"], { encoding: "utf8", windowsHide: true, timeout: 20000 });
  const diffPaths = diffRaw.split(/\r?\n/).filter(Boolean).map((x) => x.replaceAll("\\", "/"));
  const changedPaths = [...new Set([...statusPaths, ...diffPaths])].sort();
  return { head_commit: head, status_paths: statusPaths, diff_paths: diffPaths, changed_paths: changedPaths, diff_available: changedPaths.length > 0 };
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

export function runTestCommand(task, { timeoutMs = task.timeout, outputLimit = task.output_limit, spawnImpl = spawn, killTree = killProcessTree } = {}) {
  const argv = normalizeTestCommand(task.test_command);
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawnImpl(argv[0], argv.slice(1), { cwd: task.cwd || task.worktree, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current, chunk) => {
      const next = current + String(chunk);
      return next.length <= outputLimit ? next : `${next.slice(0, Math.floor(outputLimit / 2))}...[TRUNCATED]...${next.slice(-Math.floor(outputLimit / 2))}`;
    };
    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); resolve({ status: "FAIL", exit_code: null, timed_out: timedOut, stdout, stderr: append(stderr, error.message), wall_time_ms: Date.now() - started }); });
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ status: !timedOut && code === 0 ? "PASS" : "FAIL", exit_code: code, signal: signal || null, timed_out: timedOut, stdout, stderr, wall_time_ms: Date.now() - started }); });
  });
}

export function validateResultContract(result) {
  if (!isObject(result) || result.version !== RESULT_CONTRACT_VERSION) fail("result.version must be 1", "MALFORMED_RESULT");
  asString(result.task_id, "result.task_id", { max: 200 });
  if (!["DONE", "BLOCKED", "FAILED", "CANCELLED"].includes(result.status)) fail("invalid result.status", "MALFORMED_RESULT");
  if (!Array.isArray(result.changed_files) || result.changed_files.some((x) => typeof x !== "string")) fail("invalid result.changed_files", "MALFORMED_RESULT");
  if (!isObject(result.tests) || !isObject(result.diff_availability) || !isObject(result.runtime_metrics) || !isObject(result.safety_metrics) || !isObject(result.runtime_provider_identity)) fail("result evidence objects are required", "MALFORMED_RESULT");
  if (typeof result.blocker !== "string" || result.blocker.length > 4000) fail("invalid result.blocker", "MALFORMED_RESULT");
  return result;
}

export function redactStructuredLog(value, { maxString = 1000 } = {}) {
  const sensitive = /(?:secret|token|password|authorization|api[_-]?key|cookie|credential|env(?:ironment)?)/i;
  if (typeof value === "string") return value.length > maxString ? `${value.slice(0, maxString)}...[TRUNCATED]` : value;
  if (Array.isArray(value)) return value.map((entry) => redactStructuredLog(entry, { maxString }));
  if (!isObject(value)) return value;
  const output = {};
  for (const [key, entry] of Object.entries(value)) output[key] = sensitive.test(key) ? "[REDACTED]" : redactStructuredLog(entry, { maxString });
  return output;
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

export async function runLocalWorkerTask(inputTask, { adapter, runTest = runTestCommand, now = () => Date.now() } = {}) {
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
    const blocker = String(error?.message || error);
    const result = {
      version: RESULT_CONTRACT_VERSION, task_id: task.task_id, status: "BLOCKED", changed_files: [], tests: { status: "NOT_RUN" }, blocker,
      diff_availability: { available: false, files: [] }, runtime_metrics: { wall_time_ms: now() - started },
      safety_metrics: { preflight: "BLOCKED", base_commit_verified: false, changed_paths_recomputed: true, commit_detected: false, base_drift: true },
      runtime_provider_identity: runtimeAdapter.identity,
    };
    return { result: validateResultContract(result), log: redactStructuredLog({ event: "local_worker_blocked", task_id: task.task_id, status: result.status, blocker }) };
  }
  try { adapterResult = await runtimeAdapter.run(task, { boundary, before }); } catch (error) { adapterError = error; }
  const after = captureGitEvidence(task.worktree);
  const unexpected = after.changed_paths.filter((relative) => !pathAllowed(relative, task.allowed_paths));
  const committed = after.head_commit !== before.head_commit;
  const baseDrift = after.head_commit !== task.base_commit;
  let tests = { status: "NOT_RUN" };
  if (!adapterError && !unexpected.length && !committed && !baseDrift) tests = await runTest(task);
  let status = "DONE";
  let blocker = "none";
  if (adapterError) { status = "FAILED"; blocker = String(adapterError?.message || adapterError); }
  else if (unexpected.length) { status = "BLOCKED"; blocker = `unexpected changed paths: ${unexpected.join(", ")}`; }
  else if (committed) { status = "BLOCKED"; blocker = "worker commit detected; local worker must not commit"; }
  else if (baseDrift) { status = "BLOCKED"; blocker = "base commit drift detected"; }
  else if (adapterResult && typeof adapterResult.status === "string" && !["PASS", "DONE", "SUCCESS"].includes(adapterResult.status)) { status = "FAILED"; blocker = "local worker reported runtime failure"; }
  else if (tests.status !== "PASS") { status = "FAILED"; blocker = tests.timed_out ? "test timeout" : "tests did not pass"; }
  const result = {
    version: RESULT_CONTRACT_VERSION, task_id: task.task_id, status, changed_files: after.changed_paths, tests, blocker,
    diff_availability: { available: after.diff_available, files: after.diff_paths },
    runtime_metrics: { wall_time_ms: now() - started, adapter_status: typeof adapterResult?.status === "string" ? adapterResult.status : "UNTRUSTED" },
    safety_metrics: { preflight: "PASS", base_commit_verified: true, changed_paths_recomputed: true, unexpected_changes: unexpected, commit_detected: committed, base_drift: baseDrift, result_claim_trusted: false },
    runtime_provider_identity: runtimeAdapter.identity,
  };
  const log = redactStructuredLog({ event: "local_worker_result", task_id: task.task_id, status, changed_files: after.changed_paths, tests: { status: tests.status, exit_code: tests.exit_code ?? null }, blocker, runtime_provider_identity: runtimeAdapter.identity, wall_time_ms: result.runtime_metrics.wall_time_ms });
  return { result: validateResultContract(result), log };
}

export const LOCAL_RUNTIME_KIND = "minimal-harness-inference-adapter";
