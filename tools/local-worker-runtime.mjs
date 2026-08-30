import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createLifecycleRecorder, createLocalRunRecord, contractFingerprint, writeLocalRunRecordAtomic, sha256Digest, attributeGitEvidence } from "./local-run-ledger.mjs";
import { createParentResourceSampler } from "./local-resource-sampler.mjs";

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
// A private marker prevents a worker/model supplied object that merely says
// {status:"PASS"} from being accepted as parent-controlled test evidence.
// The marker is intentionally not exported and is therefore not forgeable by
// adapters or inference responses.
const PARENT_TEST_EVIDENCE = Symbol("parent-test-evidence");

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
  // Contract paths are canonical and must round-trip exactly. Reject slash
  // ambiguity, repeated separators, dot segments, encoded bytes and controls.
  if (value.includes("\\") || value.includes("//") || /[%:?\#\x00-\x1f\x7f]/.test(value)) fail(`${field} must use a canonical repository-relative path`);
  const parts = value.split("/");
  if (!parts.length || parts.some((part) => !part || part === "." || part === "..") || parts.join("/") !== value) fail(`${field} must use a canonical repository-relative path`);
  return value;
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

function boundedFailureCode(error, fallback = "PROVIDER_FAILURE") {
  const code = typeof error?.code === "string" ? error.code : "";
  return /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : fallback;
}

// Inspect a repository-relative path without ever traversing through an
// unsafe segment.  Git status/diff output is untrusted: a worker can create a
// junction after preflight, and following it while fingerprinting would read
// or mutate data outside the worktree.  Every existing ancestor is therefore
// lstat'ed from the Git root before any content operation is attempted.
function inspectPathSegments(root, relative) {
  if (!safeGitRelative(relative)) return { unsafe: true, unsafe_path: true, reparse: false, hard_link: false, segments: [] };
  const segments = [];
  let current = path.resolve(root);
  try {
    const rootStat = fs.lstatSync(current);
    if (rootStat.isSymbolicLink()) return { unsafe: true, unsafe_path: true, reparse: true, hard_link: false, segments };
    segments.push({ relative: "", stat: rootStat });
  } catch {
    return { unsafe: true, unsafe_path: true, reparse: false, hard_link: false, segments };
  }
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      // A missing leaf is a valid state for deleted paths.  Permission and
      // other inspection errors are unsafe and must fail closed.
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") break;
      return { unsafe: true, unsafe_path: true, reparse: false, hard_link: false, segments };
    }
    const segmentRelative = segments.length ? `${segments[segments.length - 1].relative ? `${segments[segments.length - 1].relative}/` : ""}${part}` : part;
    const reparse = stat.isSymbolicLink();
    const hardLink = stat.isFile() && Number.isInteger(stat.nlink) && stat.nlink > 1;
    segments.push({ relative: segmentRelative, stat });
    if (reparse || hardLink) return { unsafe: true, unsafe_path: reparse, reparse, hard_link: hardLink, segments };
  }
  return { unsafe: false, unsafe_path: false, reparse: false, hard_link: false, segments };
}

function rejectHardLinkFile(root, relative, { code = "PATH_HARDLINK_REJECTED" } = {}) {
  const candidate = path.resolve(root, relative);
  if (!fs.existsSync(candidate)) return;
  let stat;
  try { stat = fs.lstatSync(candidate); } catch { fail(`cannot inspect path: ${relative}`, "PATH_VALIDATION_FAILED"); }
  // Directory link counts are routinely greater than one; only regular files
  // are rejected as a hard-link alias to an external inode.
  if (stat.isFile() && Number.isInteger(stat.nlink) && stat.nlink > 1) fail(`hard-linked file is not allowed: ${relative}`, code);
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
    rejectHardLinkFile(normalized.worktree, relative);
  }
  return { repo: normalized.repo, worktree: normalized.worktree, git_root: gitRoot, base_commit: baseCommit, head_commit: headCommit, base_matches_head: headCommit === baseCommit };
}

function parseStatusPorcelain(raw) {
  const entries = []; const records = raw.split("\0");
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]; if (!record) continue;
    const status = record.slice(0, 2); const payload = record.slice(3);
    entries.push({ path: payload, status });
    if ((status.includes("R") || status.includes("C")) && records[i + 1]) entries.push({ path: records[++i], status });
  }
  return entries;
}
function safeGitRelative(value) {
  if (typeof value !== "string" || !value || value.length > 1024 || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return false;
  if (value.includes("\\") || value.includes("//") || value.includes("%") || /[\x00-\x1f\x7f:?\#]/.test(value)) return false;
  const parts = value.split("/");
  return parts.length > 0 && parts.every((part) => part && part !== "." && part !== "..") && parts.join("/") === value;
}

function fingerprintPath(root, relative, status) {
  if (!safeGitRelative(relative)) return { status, diff: false, fingerprint: null, fingerprint_bounded: false, unsafe_path: true };
  const maxBytes = 512 * 1024; const candidate = path.resolve(root, relative);
  try {
    const safety = inspectPathSegments(root, relative);
    if (safety.unsafe) return { status, diff: false, fingerprint: null, fingerprint_bounded: false, unsafe_path: safety.unsafe_path || false, reparse: safety.reparse || false, hard_link: safety.hard_link || false };
    const diff = execFileSync("git", ["-C", root, "diff", "HEAD", "--no-ext-diff", "--no-color", "--no-renames", "--", relative], { encoding: "utf8", windowsHide: true, timeout: 20000, maxBuffer: maxBytes });
    if (Buffer.byteLength(diff, "utf8") > maxBytes) return { status, diff: !!diff, fingerprint: null, fingerprint_bounded: false };
    if (diff) return { status, diff: true, fingerprint: sha256Digest(`${status}\0${diff}`), fingerprint_bounded: true };
    if (fs.existsSync(candidate) && fs.lstatSync(candidate).isFile()) {
      const stat = fs.lstatSync(candidate); if (stat.nlink > 1) return { status, diff: false, fingerprint: null, fingerprint_bounded: false, hard_link: true }; if (stat.size > maxBytes) return { status, diff: false, fingerprint: null, fingerprint_bounded: false };
      return { status, diff: false, fingerprint: sha256Digest(`${status}\0${fs.readFileSync(candidate)}`), fingerprint_bounded: true };
    }
    return { status, diff: false, fingerprint: sha256Digest(`${status}\0missing`), fingerprint_bounded: true };
  } catch { return { status, diff: false, fingerprint: null, fingerprint_bounded: false }; }
}

export function captureGitEvidence(worktree, { maxPaths = MAX_EVIDENCE_PATHS } = {}) {
  const root = path.resolve(worktree);
  const head = runGit(root, ["rev-parse", "HEAD"]).toLowerCase();
  const statusRaw = execFileSync("git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=all", "-z"], { encoding: "utf8", windowsHide: true, timeout: 20000 });
  const statusEntries = parseStatusPorcelain(statusRaw);
  const statusPaths = statusEntries.map((entry) => entry.path);
  const diffRaw = execFileSync("git", ["-C", root, "diff", "HEAD", "--name-only", "--no-renames"], { encoding: "utf8", windowsHide: true, timeout: 20000 });
  const diffPaths = diffRaw.split(/\r?\n/).filter(Boolean);
  const allChangedPaths = [...new Set([...statusPaths, ...diffPaths])].sort();
  const bounded = Number.isInteger(maxPaths) && maxPaths > 0 ? maxPaths : MAX_EVIDENCE_PATHS;
  const pathsTruncated = allChangedPaths.length > bounded;
  // Keep evidence bounded, but retain a count so the parent can fail closed
  // instead of accepting an incomplete changed-file claim.
  const changedPaths = allChangedPaths.slice(0, bounded);
  // Inspect every status/diff path, including paths beyond the bounded
  // evidence payload.  Truncating before safety inspection would allow an
  // unsafe tail path to be silently omitted and a false DONE claim to pass.
  const safetyByPath = Object.fromEntries(allChangedPaths.map((relative) => [relative, inspectPathSegments(root, relative)]));
  const invalidPathList = allChangedPaths.filter((relative) => !safeGitRelative(relative) || safetyByPath[relative]?.unsafe);
  const reparsePaths = allChangedPaths.filter((relative) => safetyByPath[relative]?.reparse === true);
  const hardLinkAllPaths = allChangedPaths.filter((relative) => safetyByPath[relative]?.hard_link === true);
  const statusMap = new Map(statusEntries.map((entry) => [entry.path, entry.status]));
  const pathDetails = Object.fromEntries(changedPaths.map((relative) => [relative, fingerprintPath(root, relative, statusMap.get(relative) || "DIFF")]));
  const hardLinkPaths = changedPaths.filter((relative) => pathDetails[relative]?.hard_link === true);
  return {
    head_commit: head,
    status_paths: statusPaths.slice(0, bounded),
    diff_paths: diffPaths.slice(0, bounded),
    changed_paths: changedPaths,
    changed_path_count: allChangedPaths.length,
    paths_truncated: pathsTruncated,
    diff_available: allChangedPaths.length > 0,
    path_details: pathDetails,
    invalid_paths: invalidPathList.length > 0,
    invalid_path_list: invalidPathList,
    reparse_paths: reparsePaths,
    hard_link_paths: [...new Set([...hardLinkAllPaths, ...hardLinkPaths])].sort(),
    status_counts: (() => {
      const counts = { modified: 0, added: 0, deleted: 0, untracked: 0 };
      for (const record of statusRaw.split("\0")) {
        if (!record) continue;
        const code = record.slice(0, 2);
        if (code === "??") counts.untracked += 1;
        else if (code.includes("D")) counts.deleted += 1;
        else if (code.includes("A") || code.includes("C")) counts.added += 1;
        else counts.modified += 1;
      }
      return counts;
    })(),
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
    const evidence = { command: [...argv], evidence_source: "parent-runner", parent_controlled: true };
    const onAbort = () => { cancelled = true; killTree(child); };
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    if (signal?.aborted) onAbort(); else signal?.addEventListener?.("abort", onAbort, { once: true });
    child.on("error", (error) => finish({ ...evidence, [PARENT_TEST_EVIDENCE]: true, status: cancelled ? "CANCELLED" : "FAIL", exit_code: null, timed_out: timedOut, cancelled, stdout, stderr: append(stderr, error.message), wall_time_ms: Date.now() - started }));
    child.on("close", (code, closeSignal) => finish({ ...evidence, [PARENT_TEST_EVIDENCE]: true, status: cancelled ? "CANCELLED" : (!timedOut && code === 0 ? "PASS" : "FAIL"), exit_code: code, signal: closeSignal || null, timed_out: timedOut, cancelled, stdout, stderr, wall_time_ms: Date.now() - started }));
  });
}

function sameArgv(left, right) { return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]); }

export function isParentControlledTestEvidence(value, task) {
  return isObject(value) && value[PARENT_TEST_EVIDENCE] === true
    && value.evidence_source === "parent-runner"
    && value.parent_controlled === true
    && sameArgv(value.command, task?.test_command);
}

function normalizeTestEvidence(value, outputLimit, task) {
  if (!isObject(value) || typeof value.status !== "string") return { status: "FAIL", malformed: true, evidence_valid: false, stdout: "", stderr: "malformed test result" };
  const status = ["PASS", "FAIL", "CANCELLED"].includes(value.status) ? value.status : "FAIL";
  const limit = Number.isInteger(outputLimit) && outputLimit > 0 ? outputLimit : 4000;
  const bound = (entry) => {
    const text = typeof entry === "string" ? entry : entry == null ? "" : String(entry);
    return text.length <= limit ? text : `${text.slice(0, Math.floor(limit / 2))}...[TRUNCATED]...${text.slice(-Math.floor(limit / 2))}`;
  };
  const evidenceValid = isParentControlledTestEvidence(value, task);
  const normalized = { ...value, status, evidence_valid: evidenceValid, stdout: bound(value.stdout), stderr: bound(value.stderr) };
  if (status === "PASS" && !evidenceValid) {
    normalized.status = "FAIL";
    normalized.invalid_evidence = true;
    normalized.evidence_reason = "test evidence is not parent-controlled or does not match requested test command";
  }
  return normalized;
}

export function validateResultContract(result) {
  if (!isObject(result) || result.version !== RESULT_CONTRACT_VERSION) fail("result.version must be 1", "MALFORMED_RESULT");
  asString(result.task_id, "result.task_id", { max: 200 });
  if (!["DONE", "BLOCKED", "FAILED", "CANCELLED"].includes(result.status)) fail("invalid result.status", "MALFORMED_RESULT");
  if (!Array.isArray(result.changed_files) || result.changed_files.length > MAX_RESULT_CHANGED_FILES || result.changed_files.some((x) => { try { normalizeRelativePath(x, "result.changed_files entry"); return false; } catch { return true; } })) fail("invalid result.changed_files", "MALFORMED_RESULT");
  if (!isObject(result.tests) || !isObject(result.diff_availability) || !isObject(result.runtime_metrics) || !isObject(result.safety_metrics) || !isObject(result.runtime_provider_identity)) fail("result evidence objects are required", "MALFORMED_RESULT");
  if (result.runtime_provider_identity.model !== undefined && (typeof result.runtime_provider_identity.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(result.runtime_provider_identity.model))) fail("runtime_provider_identity.model must be a logical model id", "MALFORMED_RESULT");
  if (result.diff_availability.files !== undefined && (!Array.isArray(result.diff_availability.files) || result.diff_availability.files.length > MAX_RESULT_CHANGED_FILES || result.diff_availability.files.some((x) => { try { normalizeRelativePath(x, "result.diff_availability.files entry"); return false; } catch { return true; } }))) fail("invalid result.diff_availability.files", "MALFORMED_RESULT");
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

function logicalModelIdentity(value) {
  if (typeof value !== "string" || !value.trim()) return "unknown";
  const text = value.trim().split(/[?#]/, 1)[0].replace(/\\/g, "/").replace(/\/+$/, "");
  const basename = text.split("/").pop() || "unknown";
  const safe = basename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safe) ? safe : "unknown";
}

export function sanitizeRuntimeProviderIdentity(identity) {
  const redacted = redactStructuredLog(isObject(identity) ? identity : { runtime: "local", provider: "unknown" }, { maxString: 256 });
  const output = isObject(redacted) ? { ...redacted } : { runtime: "local", provider: "unknown" };
  if (Object.prototype.hasOwnProperty.call(output, "model")) output.model = logicalModelIdentity(identity?.model);
  // Paths, prompts, source bodies and request payloads are never part of
  // public provider identity, even when an injected adapter supplies them.
  for (const key of Object.keys(output)) if (/(?:path|cwd|repo|worktree|source|prompt|request|response|body)/i.test(key)) delete output[key];
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
    identity: sanitizeRuntimeProviderIdentity(adapter.identity),
    health: typeof adapter.health === "function" ? adapter.health.bind(adapter) : async () => ({ status: "UNKNOWN" }),
    run: adapter.run.bind(adapter),
    stop: typeof adapter.stop === "function" ? adapter.stop.bind(adapter) : async () => {},
  });
}

export async function runLocalWorkerTask(inputTask, { adapter, runTest = runTestCommand, now = () => Date.now(), failureGuard = null, signal = null, runLedgerDir = null, runId = null, selection = null, ledgerWriter = writeLocalRunRecordAtomic, resourceSampler: suppliedResourceSampler = null, resourceSamplerFactory = createParentResourceSampler } = {}) {
  const task = validateTaskContract(inputTask, { verifyGit: false });
  const runtimeAdapter = createInferenceAdapter(adapter);
  const started = now();
  const localRunId = typeof runId === "string" && runId.trim() ? runId.trim() : crypto.randomUUID();
  const lifecycle = createLifecycleRecorder(now);
  let ledgerWrite = null;
  let resourceSampler = null;
  let measuredResources = null;
  const stopResourceSampler = () => {
    if (!resourceSampler) return measuredResources;
    try { measuredResources = resourceSampler.stop(); } catch { measuredResources = null; }
    resourceSampler = null;
    return measuredResources;
  };
  const writeLedger = (result, { beforeEvidence = before, afterEvidence = after, baselineClean = beforeEvidence ? beforeEvidence.changed_path_count === 0 : null } = {}) => {
    if (!runLedgerDir) return;
    try {
      const adapterMetrics = adapterResult?.metrics || {};
      const attributedLedger = beforeEvidence && afterEvidence ? attributeGitEvidence(beforeEvidence, afterEvidence) : { paths: [], diff_paths: [] };
      // Parent timing and resources are measured at this boundary, never
      // copied from adapter/harness values.
      const parentWall = Math.max(0, now() - started);
      const clean = createLocalRunRecord({
        run_id: localRunId,
        selection: selection || runtimeAdapter.identity,
        contract_fingerprint: contractFingerprint(task),
        base_commit: task.base_commit,
        baseline: beforeEvidence ? {
          clean: baselineClean,
          ...(beforeEvidence.status_counts || {}),
          digest: beforeEvidence.changed_paths?.length ? sha256Digest(beforeEvidence.changed_paths) : sha256Digest([]),
        } : {},
        lifecycle_ms: lifecycle.snapshot(),
        harness: {
          // Only values captured by this parent belong in parent_measured.
          // first_tool/tool_calls/tokens are worker-reported observations and
          // must carry an explicit non-parent provenance.
          parent_measured: { wall_time_ms: parentWall, first_tool: null, source: "parent_measured" },
          harness_reported: { first_tool: adapterMetrics.first_tool, first_tool_latency_ms: adapterMetrics.first_tool_latency_ms, tool_calls: adapterMetrics.tool_calls, wall_time_ms: adapterMetrics.wall_time_ms, source: "harness_reported" },
          adapter_reported: { first_tool: adapterMetrics.first_tool, first_tool_latency_ms: adapterMetrics.first_tool_latency_ms, tool_calls: adapterMetrics.tool_calls, wall_time_ms: adapterMetrics.wall_time_ms, source: "adapter_reported" },
          provider_usage: { prompt_tokens: adapterMetrics.prompt_tokens, completion_tokens: adapterMetrics.completion_tokens, total_tokens: adapterMetrics.total_tokens, source: "provider_usage" },
        },
        resources: measuredResources || {},
        outcome: {
          status: result?.status,
          changed: { count: attributedLedger.paths.length, paths: attributedLedger.paths, digest: attributedLedger.paths.length ? sha256Digest(attributedLedger.paths) : sha256Digest([]) },
          diff: { count: attributedLedger.diff_paths.length, paths: attributedLedger.diff_paths, digest: attributedLedger.diff_paths.length ? sha256Digest(attributedLedger.diff_paths) : sha256Digest([]) },
          attribution: { paths: attributedLedger.paths, details: attributedLedger.details },
          tests: { status: result?.tests?.status || "NOT_RUN", count: result?.tests?.status === "PASS" ? 1 : 0, digest: result?.tests?.status ? sha256Digest({ status: result.tests.status, evidence_valid: result.tests.evidence_valid === true }) : null },
          base_drift: result?.safety_metrics?.base_drift === true,
          commit_detected: result?.safety_metrics?.commit_detected === true,
        },
        evidence: { digest: attributedLedger.paths.length ? sha256Digest(attributedLedger.paths) : sha256Digest([]) },
        ownership: { provider: adapterResult ? "ADAPTER" : "UNKNOWN", cleanup: "UNKNOWN", cleanup_verified: false },
      });
      const target = ledgerWriter(runLedgerDir, clean);
      ledgerWrite = { status: "WRITTEN", code: "LEDGER_WRITTEN", path: typeof target === "string" ? path.basename(target) : null };
    } catch {
      // Observability is intentionally non-authoritative. A ledger failure
      // must never alter Task/Result status or trigger a retry.
      ledgerWrite = { status: "FAILED", code: "LEDGER_WRITE_FAILED", path: null };
    }
  };
  let boundary;
  let before;
  let adapterResult = null;
  let adapterError = null;
  lifecycle.mark("preflight_start");
  try {
    boundary = validateTaskBoundary(task);
    if (!boundary.base_matches_head) fail("base commit drift before worker start", "BASE_COMMIT_DRIFT");
    before = captureGitEvidence(task.worktree);
  } catch (error) {
    lifecycle.mark("preflight_end");
    const blocker = redactStructuredLog(String(error?.message || error), { maxString: 4000 });
    const drift = error?.code === "BASE_COMMIT_DRIFT" || error?.code === "BASE_COMMIT_INVALID";
    const result = {
      version: RESULT_CONTRACT_VERSION, task_id: task.task_id, status: "BLOCKED", changed_files: [], tests: { status: "NOT_RUN" }, blocker,
      diff_availability: { available: false, files: [] }, runtime_metrics: { wall_time_ms: now() - started },
      safety_metrics: { preflight: "BLOCKED", base_commit_verified: false, changed_paths_recomputed: true, commit_detected: false, base_drift: drift },
      runtime_provider_identity: runtimeAdapter.identity,
    };
    writeLedger(result, { beforeEvidence: before || null, afterEvidence: null, baselineClean: false });
    return { run_id: localRunId, result: validateResultContract(result), log: redactStructuredLog({ event: "local_worker_blocked", task_id: task.task_id, status: result.status, blocker }), ledger: ledgerWrite };
  }
  lifecycle.mark("preflight_end");
  // Observe from the parent before invoking the provider, so a provider crash
  // still leaves target-device before/after measurements. The sampler is
  // read-only and never enumerates or terminates provider processes.
  resourceSampler = suppliedResourceSampler || resourceSamplerFactory({ deviceIndex: Number.isInteger(runtimeAdapter.identity?.device_index) ? runtimeAdapter.identity.device_index : 0, signal, maxDurationMs: task.timeout });
  resourceSampler.start();
  try { adapterResult = await runtimeAdapter.run(task, { boundary, before, signal, runTest, onLifecycle: (event) => lifecycle.mark(event) }); } catch (error) { adapterError = error; }
  // A provider crash must not strand an owned process. Adapters are required
  // to make stop() ownership-aware (external engines remain untouched).
  if (adapterError) { lifecycle.mark("cleanup_start"); try { await runtimeAdapter.stop(); } catch { /* cleanup is best effort */ } lifecycle.mark("cleanup_end"); }
  let after;
  let postflightError = null;
  lifecycle.mark("postflight_start");
  try {
    // Re-run the reparse/root checks after provider execution: a worker can
    // create a junction after preflight and then write through it.
    validateTaskBoundary(task);
    after = captureGitEvidence(task.worktree);
  } catch (error) {
    postflightError = error;
    after = { head_commit: before.head_commit, status_paths: [], diff_paths: [], changed_paths: [], changed_path_count: 0, paths_truncated: false, invalid_paths: false, diff_available: false, path_details: {} };
  }
  lifecycle.mark("postflight_end");
  const invalidPaths = !!(before.invalid_paths || after.invalid_paths);
  const invalidPathList = [...new Set([...(before.invalid_path_list || []), ...(after.invalid_path_list || [])])].sort();
  const reparsePaths = [...new Set([...(before.reparse_paths || []), ...(after.reparse_paths || [])])].sort();
  const hardLinkEvidencePaths = [...new Set([...(before.hard_link_paths || []), ...(after.hard_link_paths || [])])].sort();
  // Do not let malformed path evidence enter the ledger/result serializer;
  // captureGitEvidence has already recorded the fail-closed condition.
  let attributed = { paths: [], diff_paths: [], details: {}, uncertain_paths: [] };
  if (!invalidPaths) {
    try { attributed = attributeGitEvidence(before, after); }
    catch { attributed = { paths: [], diff_paths: [], details: {}, uncertain_paths: [] }; }
  }
  const attributedPaths = attributed.paths;
  const unexpected = attributedPaths.filter((relative) => !pathAllowed(relative, task.allowed_paths));
  const attributionUncertain = attributed.uncertain_paths || [];
  const evidenceTruncated = !!after.paths_truncated;
  const committed = after.head_commit !== before.head_commit;
  const baseDrift = after.head_commit !== task.base_commit;
  let tests = { status: "NOT_RUN", evidence_valid: false };
  if (!adapterError && !postflightError && !evidenceTruncated && !invalidPaths && !attributionUncertain.length && !unexpected.length && !committed && !baseDrift) {
    lifecycle.mark("test_start");
    try { tests = normalizeTestEvidence(await runTest(task, { signal }), task.output_limit, task); } catch (error) {
      tests = { status: "FAIL", evidence_valid: false, timed_out: false, cancelled: false, stdout: "", stderr: redactStructuredLog(String(error?.message || error), { maxString: task.output_limit }), wall_time_ms: 0 };
    } finally { lifecycle.mark("test_end"); }
  }
  let status = "DONE";
  let blocker = "none";
  let failureFingerprint = null;
  if (adapterError) {
    status = "FAILED";
    const code = boundedFailureCode(adapterError);
    blocker = `local worker provider failure: ${code}${code === "PROVIDER_FAILURE" ? " [REDACTED]" : ""}`;
    if (failureGuard?.record) {
      const repeat = failureGuard.record(adapterError);
      failureFingerprint = repeat.fingerprint;
      if (repeat.abort) { status = "BLOCKED"; blocker = "duplicate failure fingerprint threshold reached"; }
    }
  }
  else if (postflightError) { status = "BLOCKED"; blocker = `postflight validation failed: ${boundedFailureCode(postflightError, "POSTFLIGHT_FAILED")}`; }
  else if (evidenceTruncated) { status = "BLOCKED"; blocker = `changed-file evidence exceeds ${MAX_EVIDENCE_PATHS} paths`; }
  else if (invalidPaths) { status = "BLOCKED"; blocker = "Git evidence contains an unsafe path"; }
  else if (attributionUncertain.length) { status = "BLOCKED"; blocker = `changed-file fingerprint exceeds bounded evidence: ${attributionUncertain.join(", ")}`; }
  else if (unexpected.length) { status = "BLOCKED"; blocker = `unexpected changed paths: ${unexpected.join(", ")}`; }
  else if (committed) { status = "BLOCKED"; blocker = "worker commit detected; local worker must not commit"; }
  else if (baseDrift) { status = "BLOCKED"; blocker = "base commit drift detected"; }
  else if (!adapterResult || typeof adapterResult !== "object" || typeof adapterResult.status !== "string") { status = "FAILED"; blocker = "malformed local worker provider result"; }
  else if (adapterResult && typeof adapterResult.status === "string" && !["PASS", "DONE", "SUCCESS"].includes(adapterResult.status)) {
    status = adapterResult.status === "BLOCKED" ? "BLOCKED" : adapterResult.status === "CANCELLED" ? "CANCELLED" : "FAILED";
    blocker = adapterResult.status === "BLOCKED" ? "local worker provider blocked" : `local worker reported runtime failure: ${boundedFailureCode(adapterResult)}`;
  }
  else if (!attributedPaths.length || !attributed.diff_paths.length) { status = "FAILED"; blocker = "no nonempty bounded diff was produced"; }
  else if (tests.status !== "PASS" || tests.evidence_valid !== true) {
    status = tests.status === "CANCELLED" || tests.cancelled ? "CANCELLED" : "FAILED";
    if (tests.timed_out) blocker = "test timeout (requested test command exceeded deadline)";
    else if (tests.cancelled) blocker = "test cancelled";
    else if (tests.invalid_evidence || tests.evidence_valid !== true) blocker = "test evidence is not parent-controlled or does not match requested test command";
    else blocker = "tests did not pass";
  }
  stopResourceSampler();
  const result = {
    version: RESULT_CONTRACT_VERSION, task_id: task.task_id, status, changed_files: attributedPaths, tests, blocker,
    diff_availability: { available: attributed.diff_paths.length > 0, files: attributed.diff_paths },
    runtime_metrics: { wall_time_ms: now() - started, adapter_status: typeof adapterResult?.status === "string" ? adapterResult.status : "UNTRUSTED", failure_code: boundedFailureCode(adapterResult, adapterError ? boundedFailureCode(adapterError) : "NONE"), failure_fingerprint: failureFingerprint, first_tool: adapterResult?.metrics?.first_tool || null },
    resources: measuredResources,
    safety_metrics: { preflight: "PASS", postflight: postflightError ? "BLOCKED" : "PASS", base_commit_verified: true, changed_paths_recomputed: true, attributed_paths: attributedPaths, preexisting_paths_excluded: before.changed_paths.filter((p) => !attributedPaths.includes(p)), attribution: attributed.details, attribution_uncertain: attributionUncertain, invalid_paths: !!invalidPaths, invalid_path_list: invalidPathList, reparse_paths: reparsePaths, hard_link_paths: hardLinkEvidencePaths, unexpected_changes: unexpected, commit_detected: committed, base_drift: baseDrift, evidence_truncated: evidenceTruncated, result_claim_trusted: false },
    runtime_provider_identity: runtimeAdapter.identity,
  };
  const log = redactStructuredLog({ event: "local_worker_result", task_id: task.task_id, status, changed_files: attributedPaths, tests: { status: tests.status, exit_code: tests.exit_code ?? null }, blocker, runtime_provider_identity: runtimeAdapter.identity, wall_time_ms: result.runtime_metrics.wall_time_ms });
  writeLedger(result, { beforeEvidence: before, afterEvidence: after, baselineClean: before.changed_path_count === 0 });
  return { run_id: localRunId, result: validateResultContract(result), log, ledger: ledgerWrite };
}

export const LOCAL_RUNTIME_KIND = "minimal-harness-inference-adapter";
