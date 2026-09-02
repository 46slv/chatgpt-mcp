import crypto from "node:crypto";
import { spawn } from "node:child_process";

import {
  CODEX_RUNTIME_ERRORS,
  normalizeCodexRuntimePath,
  validateCodexRuntimeBinding,
  verifyCodexRuntimeBinding,
} from "./devexec-codex-runtime-binding.mjs";

export const CODEX_CONTINUATION_BINDING_PROTOCOL = "devexec.codex-continuation-binding";
export const CODEX_CONTINUATION_BINDING_SCHEMA_VERSION = 1;
export const CODEX_CONTINUATION_RETURN_PROTOCOL = "devexec.codex-continuation-return";
export const CODEX_CONTINUATION_RETURN_SCHEMA_VERSION = 1;

export const CODEX_CONTINUATION_MODE = Object.freeze({ QUEUE: "queue", RESUME: "resume" });

export const CODEX_CONTINUATION_ERRORS = Object.freeze({
  BINDING_REQUIRED: "CONTINUATION_BINDING_REQUIRED",
  BINDING_INVALID: "CONTINUATION_BINDING_INVALID",
  BINDING_MISMATCH: "CONTINUATION_BINDING_MISMATCH",
  TASK_MISMATCH: "CONTINUATION_TASK_MISMATCH",
  IDENTITY_MISMATCH: "CONTINUATION_IDENTITY_MISMATCH",
  RETURN_REQUIRED: "CONTINUATION_RETURN_REQUIRED",
  RETURN_INVALID: "CONTINUATION_RETURN_INVALID",
  RETURN_CONFLICT: "CONTINUATION_RETURN_CONFLICT",
  DELIVERY_UNKNOWN: "CONTINUATION_DELIVERY_UNKNOWN",
  CAPABILITY_UNAVAILABLE: "CODEX_CAPABILITY_UNAVAILABLE",
  EPHEMERAL_SESSION: "CONTINUATION_EPHEMERAL_SESSION",
  EXECUTION_FAILED: "CONTINUATION_EXECUTION_FAILED",
  RUNTIME_REQUIRED: CODEX_RUNTIME_ERRORS.REQUIRED,
  RUNTIME_INVALID: CODEX_RUNTIME_ERRORS.INVALID,
  RUNTIME_UNAVAILABLE: CODEX_RUNTIME_ERRORS.UNAVAILABLE,
  RUNTIME_DRIFT: CODEX_RUNTIME_ERRORS.DRIFT,
  RUNTIME_CAPABILITY_UNAVAILABLE: CODEX_RUNTIME_ERRORS.CAPABILITY_UNAVAILABLE,
  RUNTIME_PROBE_FAILED: CODEX_RUNTIME_ERRORS.PROBE_FAILED,
});

export const CONTINUATION_BINDING_REQUIRED = CODEX_CONTINUATION_ERRORS.BINDING_REQUIRED;
export const CONTINUATION_BINDING_INVALID = CODEX_CONTINUATION_ERRORS.BINDING_INVALID;
export const CONTINUATION_BINDING_MISMATCH = CODEX_CONTINUATION_ERRORS.BINDING_MISMATCH;
export const CONTINUATION_TASK_MISMATCH = CODEX_CONTINUATION_ERRORS.TASK_MISMATCH;
export const CONTINUATION_IDENTITY_MISMATCH = CODEX_CONTINUATION_ERRORS.IDENTITY_MISMATCH;
export const CONTINUATION_RETURN_REQUIRED = CODEX_CONTINUATION_ERRORS.RETURN_REQUIRED;
export const CONTINUATION_RETURN_INVALID = CODEX_CONTINUATION_ERRORS.RETURN_INVALID;
export const CONTINUATION_RETURN_CONFLICT = CODEX_CONTINUATION_ERRORS.RETURN_CONFLICT;
export const CONTINUATION_DELIVERY_UNKNOWN = CODEX_CONTINUATION_ERRORS.DELIVERY_UNKNOWN;
export const CODEX_RUNTIME_BINDING_REQUIRED = CODEX_RUNTIME_ERRORS.REQUIRED;
export const CODEX_RUNTIME_BINDING_INVALID = CODEX_RUNTIME_ERRORS.INVALID;
export const CODEX_RUNTIME_UNAVAILABLE = CODEX_RUNTIME_ERRORS.UNAVAILABLE;
export const CODEX_RUNTIME_DRIFT = CODEX_RUNTIME_ERRORS.DRIFT;
export const CODEX_RUNTIME_CAPABILITY_UNAVAILABLE = CODEX_RUNTIME_ERRORS.CAPABILITY_UNAVAILABLE;
export const CODEX_RUNTIME_PROBE_FAILED = CODEX_RUNTIME_ERRORS.PROBE_FAILED;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUEUE_SUCCESS_RE = /^Queued message ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) for thread ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.$/;
const BINDING_FIELDS = Object.freeze([
  "protocol",
  "schema_version",
  "mission_id",
  "task_id",
  "thread_id",
  "working_directory",
  "repo_root",
  "session_persisted",
  "bound_at",
  "binding_id",
]);
const HASH_FIELDS = Object.freeze(BINDING_FIELDS.filter((field) => field !== "binding_id"));

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class CodexContinuationError extends Error {
  constructor(message, code = CODEX_CONTINUATION_ERRORS.RETURN_INVALID) {
    super(message);
    this.name = "CodexContinuationError";
    this.code = code;
  }
}

function fail(code, message, cause = undefined) {
  const error = new CodexContinuationError(message, code);
  if (cause !== undefined) error.cause = cause;
  throw error;
}

function requiredText(value, label, code = CODEX_CONTINUATION_ERRORS.RETURN_REQUIRED) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    fail(code, `${label} must be an exact non-empty string.`);
  }
  return value;
}

function optionalText(value, label) {
  if (value === null) return null;
  return requiredText(value, label, CODEX_CONTINUATION_ERRORS.BINDING_INVALID);
}

function promptText(value, code) {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) {
    fail(code, "prompt must be a non-empty string.");
  }
  return value;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function canonicalDigest(fields) {
  const payload = {};
  for (const field of HASH_FIELDS) {
    if (field === "protocol") payload[field] = CODEX_CONTINUATION_BINDING_PROTOCOL;
    else if (field === "schema_version") payload[field] = CODEX_CONTINUATION_BINDING_SCHEMA_VERSION;
    else payload[field] = fields[field];
  }
  return sha256(JSON.stringify(payload));
}

function normalizeThreadId(value, code = CODEX_CONTINUATION_ERRORS.BINDING_REQUIRED) {
  const threadId = requiredText(value, "thread_id", code);
  if (!UUID_RE.test(threadId)) fail(CODEX_CONTINUATION_ERRORS.BINDING_INVALID, "thread_id must be a Codex session UUID.");
  return threadId;
}

function normalizeBindingInput(input) {
  if (!isObject(input)) fail(CODEX_CONTINUATION_ERRORS.BINDING_REQUIRED, "Codex continuation binding input is required.");

  const persisted = firstDefined(input.session_persisted, input.persisted);
  if (input.ephemeral === true || persisted === false) {
    fail(CODEX_CONTINUATION_ERRORS.EPHEMERAL_SESSION, "Ephemeral Codex sessions cannot be used for continuation.");
  }
  if (persisted !== undefined && persisted !== true) {
    fail(CODEX_CONTINUATION_ERRORS.BINDING_INVALID, "session_persisted must be true.");
  }

  const repoCandidate = firstDefined(
    input.repo_root,
    input.repository_root,
    typeof input.repo === "string" ? input.repo : undefined,
    isObject(input.repo) ? firstDefined(input.repo.root, input.repo.repo_root) : undefined,
  );
  const repoRoot = repoCandidate === undefined ? null : optionalText(repoCandidate, "repo_root");
  const boundAtCandidate = firstDefined(input.bound_at, input.created_at);

  return {
    mission_id: requiredText(input.mission_id, "mission_id", CODEX_CONTINUATION_ERRORS.BINDING_REQUIRED),
    task_id: requiredText(input.task_id, "task_id", CODEX_CONTINUATION_ERRORS.BINDING_REQUIRED),
    thread_id: normalizeThreadId(firstDefined(input.thread_id, input.session_id)),
    working_directory: requiredText(
      firstDefined(input.working_directory, input.cwd, process.cwd()),
      "working_directory",
      CODEX_CONTINUATION_ERRORS.BINDING_REQUIRED,
    ),
    repo_root: repoRoot,
    session_persisted: true,
    bound_at: boundAtCandidate === undefined
      ? new Date().toISOString()
      : requiredText(boundAtCandidate, "bound_at", CODEX_CONTINUATION_ERRORS.BINDING_INVALID),
  };
}

function bindingFromFields(fields) {
  return Object.freeze({
    protocol: CODEX_CONTINUATION_BINDING_PROTOCOL,
    schema_version: CODEX_CONTINUATION_BINDING_SCHEMA_VERSION,
    mission_id: fields.mission_id,
    task_id: fields.task_id,
    thread_id: fields.thread_id,
    working_directory: fields.working_directory,
    repo_root: fields.repo_root,
    session_persisted: true,
    bound_at: fields.bound_at,
    binding_id: canonicalDigest(fields),
  });
}

function canonicalizeStoredBinding(value) {
  if (!isObject(value)) fail(CODEX_CONTINUATION_ERRORS.BINDING_INVALID, "Codex continuation binding must be an object.");
  for (const field of BINDING_FIELDS) {
    if (!hasOwn(value, field)) fail(CODEX_CONTINUATION_ERRORS.BINDING_INVALID, `Codex continuation binding field is missing: ${field}.`);
  }
  for (const field of Object.keys(value)) {
    if (!BINDING_FIELDS.includes(field)) fail(CODEX_CONTINUATION_ERRORS.BINDING_INVALID, `Unknown continuation binding field: ${field}.`);
  }
  if (value.protocol !== CODEX_CONTINUATION_BINDING_PROTOCOL || value.schema_version !== CODEX_CONTINUATION_BINDING_SCHEMA_VERSION) {
    fail(CODEX_CONTINUATION_ERRORS.BINDING_INVALID, "Unsupported Codex continuation binding protocol or schema_version.");
  }
  if (value.session_persisted !== true) fail(CODEX_CONTINUATION_ERRORS.EPHEMERAL_SESSION, "Only persisted Codex sessions are eligible for continuation.");

  const fields = {
    mission_id: requiredText(value.mission_id, "mission_id", CODEX_CONTINUATION_ERRORS.BINDING_INVALID),
    task_id: requiredText(value.task_id, "task_id", CODEX_CONTINUATION_ERRORS.BINDING_INVALID),
    thread_id: normalizeThreadId(value.thread_id, CODEX_CONTINUATION_ERRORS.BINDING_INVALID),
    working_directory: requiredText(value.working_directory, "working_directory", CODEX_CONTINUATION_ERRORS.BINDING_INVALID),
    repo_root: optionalText(value.repo_root, "repo_root"),
    session_persisted: true,
    bound_at: requiredText(value.bound_at, "bound_at", CODEX_CONTINUATION_ERRORS.BINDING_INVALID),
  };
  const expected = canonicalDigest(fields);
  if (value.binding_id !== expected) fail(CODEX_CONTINUATION_ERRORS.BINDING_INVALID, "binding_id does not match the canonical continuation binding.");
  return { ...fields, binding_id: expected };
}

/** Create an immutable parent-owned binding from an exact persisted Codex session identity. */
export function createCodexContinuationBinding(input = {}) {
  const binding = bindingFromFields(normalizeBindingInput(input));
  if (input.binding_id !== undefined && input.binding_id !== binding.binding_id) {
    fail(CODEX_CONTINUATION_ERRORS.BINDING_INVALID, "Supplied binding_id does not match the parent-owned continuation binding.");
  }
  return binding;
}

export const bindCodexContinuation = createCodexContinuationBinding;
export const createCodexTaskContinuationBinding = createCodexContinuationBinding;

/** Validate and return a canonical immutable copy of parent state. */
export function validateCodexContinuationBinding(value) {
  if (value === null || value === undefined) fail(CODEX_CONTINUATION_ERRORS.BINDING_REQUIRED, "Codex continuation binding is required.");
  const fields = canonicalizeStoredBinding(value);
  return Object.freeze({
    protocol: CODEX_CONTINUATION_BINDING_PROTOCOL,
    schema_version: CODEX_CONTINUATION_BINDING_SCHEMA_VERSION,
    ...fields,
  });
}

function normalizeResponseId(input, promptHash) {
  const candidate = firstDefined(input.response_id, input.relay_id, input.prompt_id);
  return candidate === undefined ? promptHash : requiredText(candidate, "response_id", CODEX_CONTINUATION_ERRORS.RETURN_REQUIRED);
}

function returnIdentityDigest(fields) {
  return sha256(JSON.stringify({
    protocol: CODEX_CONTINUATION_RETURN_PROTOCOL,
    schema_version: CODEX_CONTINUATION_RETURN_SCHEMA_VERSION,
    mission_id: fields.mission_id,
    task_id: fields.task_id,
    binding_id: fields.binding_id,
    response_id: fields.response_id,
  }));
}

function returnFromFields(fields) {
  const promptHash = sha256(fields.prompt);
  const responseId = normalizeResponseId(fields, promptHash);
  const identity = returnIdentityDigest({ ...fields, response_id: responseId });
  return Object.freeze({
    protocol: CODEX_CONTINUATION_RETURN_PROTOCOL,
    schema_version: CODEX_CONTINUATION_RETURN_SCHEMA_VERSION,
    mission_id: fields.mission_id,
    task_id: fields.task_id,
    binding_id: fields.binding_id,
    thread_id: fields.thread_id,
    response_id: responseId,
    prompt: fields.prompt,
    prompt_sha256: promptHash,
    return_id: identity,
    dedupe_key: identity,
  });
}

/** Build a parent-owned return request; the request contains no ChatGPT URL. */
export function createCodexContinuationReturn({ binding, prompt, response_id, relay_id, prompt_id } = {}) {
  const validated = validateCodexContinuationBinding(binding);
  promptText(prompt, CODEX_CONTINUATION_ERRORS.RETURN_REQUIRED);
  return returnFromFields({
    mission_id: validated.mission_id,
    task_id: validated.task_id,
    binding_id: validated.binding_id,
    thread_id: validated.thread_id,
    prompt,
    response_id,
    relay_id,
    prompt_id,
  });
}

export const createCodexContinuationRequest = createCodexContinuationReturn;
export const createCodexReturnRequest = createCodexContinuationReturn;

/** Validate a return request against the exact parent binding and recompute its identity. */
export function validateCodexContinuationReturn(value, binding) {
  if (value === null || value === undefined) fail(CODEX_CONTINUATION_ERRORS.RETURN_REQUIRED, "Codex continuation return request is required.");
  const validatedBinding = validateCodexContinuationBinding(binding);
  if (!isObject(value)) fail(CODEX_CONTINUATION_ERRORS.RETURN_INVALID, "Codex continuation return request must be an object.");
  const requiredFields = ["protocol", "schema_version", "mission_id", "task_id", "binding_id", "thread_id", "response_id", "prompt", "prompt_sha256", "return_id", "dedupe_key"];
  for (const field of requiredFields) {
    if (!hasOwn(value, field)) fail(CODEX_CONTINUATION_ERRORS.RETURN_INVALID, `Codex continuation return field is missing: ${field}.`);
  }
  if (value.protocol !== CODEX_CONTINUATION_RETURN_PROTOCOL || value.schema_version !== CODEX_CONTINUATION_RETURN_SCHEMA_VERSION) {
    fail(CODEX_CONTINUATION_ERRORS.RETURN_INVALID, "Unsupported Codex continuation return protocol or schema_version.");
  }
  if (value.mission_id !== validatedBinding.mission_id || value.task_id !== validatedBinding.task_id) {
    fail(CODEX_CONTINUATION_ERRORS.TASK_MISMATCH, "Continuation return mission/task identity does not match the stored binding.");
  }
  if (value.binding_id !== validatedBinding.binding_id || value.thread_id !== validatedBinding.thread_id) {
    fail(CODEX_CONTINUATION_ERRORS.BINDING_MISMATCH, "Continuation return binding/thread identity does not match parent state.");
  }
  const prompt = promptText(value.prompt, CODEX_CONTINUATION_ERRORS.RETURN_INVALID);
  const promptHash = sha256(prompt);
  if (value.prompt_sha256 !== promptHash) fail(CODEX_CONTINUATION_ERRORS.RETURN_INVALID, "prompt_sha256 does not match prompt bytes.");
  const responseId = requiredText(value.response_id, "response_id", CODEX_CONTINUATION_ERRORS.RETURN_INVALID);
  const expected = returnIdentityDigest({
    mission_id: validatedBinding.mission_id,
    task_id: validatedBinding.task_id,
    binding_id: validatedBinding.binding_id,
    response_id: responseId,
  });
  if (value.return_id !== expected || value.dedupe_key !== expected) {
    fail(CODEX_CONTINUATION_ERRORS.RETURN_INVALID, "return_id/dedupe_key does not match the parent-owned return identity.");
  }
  return Object.freeze({
    protocol: CODEX_CONTINUATION_RETURN_PROTOCOL,
    schema_version: CODEX_CONTINUATION_RETURN_SCHEMA_VERSION,
    mission_id: validatedBinding.mission_id,
    task_id: validatedBinding.task_id,
    binding_id: validatedBinding.binding_id,
    thread_id: validatedBinding.thread_id,
    response_id: responseId,
    prompt,
    prompt_sha256: promptHash,
    return_id: expected,
    dedupe_key: expected,
  });
}

export const validateCodexContinuationRequest = validateCodexContinuationReturn;
export const validateCodexReturnRequest = validateCodexContinuationReturn;

/** Build the only unattended command shapes permitted by this seam. */
export function buildCodexContinuationInvocation({ binding, request, mode, runtime } = {}) {
  const validatedBinding = validateCodexContinuationBinding(binding);
  const validatedRuntime = validateCodexRuntimeBinding(runtime);
  const validatedRequest = validateCodexContinuationReturn(request, validatedBinding);
  const selectedMode = mode || CODEX_CONTINUATION_MODE.QUEUE;
  if (!Object.values(CODEX_CONTINUATION_MODE).includes(selectedMode)) {
    fail(CODEX_CONTINUATION_ERRORS.CAPABILITY_UNAVAILABLE, `Unsupported Codex continuation mode: ${selectedMode}.`);
  }
  if (selectedMode === CODEX_CONTINUATION_MODE.RESUME && validatedBinding.session_persisted !== true) {
    fail(CODEX_CONTINUATION_ERRORS.EPHEMERAL_SESSION, "Resume requires a persisted Codex session.");
  }
  if (validatedRuntime.capabilities[selectedMode] !== true) {
    fail(CODEX_RUNTIME_ERRORS.CAPABILITY_UNAVAILABLE, `Bound Codex runtime lacks required capability: ${selectedMode}.`);
  }
  const continuationArgs = selectedMode === CODEX_CONTINUATION_MODE.QUEUE
    ? ["queue", "--thread", validatedBinding.thread_id, "--message", validatedRequest.prompt]
    : ["exec", "resume", "--json", validatedBinding.thread_id, validatedRequest.prompt];
  return Object.freeze({
    command: validatedRuntime.executable_path,
    args: Object.freeze([...validatedRuntime.launch_args, ...continuationArgs]),
    cwd: validatedBinding.working_directory,
    mode: selectedMode,
    thread_id: validatedBinding.thread_id,
    return_id: validatedRequest.return_id,
    runtime_binding_id: validatedRuntime.binding_id,
    runtime_fingerprint: validatedRuntime.runtime_fingerprint,
  });
}

function commandLines(helpText) {
  return String(helpText || "").split(/\r?\n/).map((line) => line.trimEnd());
}

/** Parse only explicit command-list entries from `codex --help`. */
export function parseCodexCapabilities(helpText) {
  const lines = commandLines(helpText);
  const hasCommand = (name) => lines.some((line) => new RegExp(`^\\s{2,}${name}(?:\\s{2,}|$)`).test(line));
  return Object.freeze({ queue: hasCommand("queue"), resume: hasCommand("resume") });
}

function normalizeCapabilities(value) {
  if (typeof value === "string") return parseCodexCapabilities(value);
  if (!isObject(value)) return Object.freeze({ queue: false, resume: false });
  return Object.freeze({ queue: value.queue === true, resume: value.resume === true });
}

function exitCodeOf(result) {
  if (!isObject(result)) return 0;
  const value = firstDefined(result.exitCode, result.code, result.status);
  return value === undefined || value === null ? 0 : Number(value);
}

/** Bounded process adapter; callers must supply the already-bound absolute runtime path. */
export function invokeCodexProcess({ command, args = [], cwd, timeoutMs = 30000 } = {}) {
  const executable = normalizeCodexRuntimePath(command, "codex command", CODEX_RUNTIME_ERRORS.REQUIRED);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new CodexContinuationError("Codex process timed out.", CODEX_CONTINUATION_ERRORS.DELIVERY_UNKNOWN));
    }, Math.max(1, Number(timeoutMs) || 30000));
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: Number.isInteger(code) ? code : -1, stdout, stderr });
    });
  });
}

export async function probeCodexCapabilities({ command, cwd = process.cwd(), invoke = invokeCodexProcess } = {}) {
  const executable = normalizeCodexRuntimePath(command, "codex command", CODEX_RUNTIME_ERRORS.REQUIRED);
  let result;
  try {
    result = await invoke({ command: executable, args: ["--help"], cwd, purpose: "capability-probe" });
  } catch (error) {
    fail(CODEX_CONTINUATION_ERRORS.CAPABILITY_UNAVAILABLE, "Codex capability probe failed.", error);
  }
  if (exitCodeOf(result) !== 0) fail(CODEX_CONTINUATION_ERRORS.CAPABILITY_UNAVAILABLE, "Codex capability probe returned a non-zero exit code.");
  const capabilities = parseCodexCapabilities(result?.stdout || result?.output || "");
  if (!capabilities.queue && !capabilities.resume) fail(CODEX_CONTINUATION_ERRORS.CAPABILITY_UNAVAILABLE, "Codex exposes neither queue nor resume continuation.");
  return capabilities;
}

function threadStartedId(event) {
  if (!isObject(event) || (event.type !== "thread.started" && event.event !== "thread.started")) return null;
  return firstDefined(event.thread_id, event.thread?.thread_id, event.thread?.id, event.session_id) || null;
}

/** Extract `thread.started.thread_id` values from JSONL or injected event arrays. */
export function parseCodexThreadStartedIds(value) {
  const events = [];
  const parseErrors = [];
  if (Array.isArray(value)) {
    events.push(...value);
  } else if (isObject(value)) {
    events.push(value);
  } else {
    for (const line of String(value || "").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); }
      catch (error) { parseErrors.push(String(error.message || error)); }
    }
  }
  const ids = events.map(threadStartedId).filter((id) => typeof id === "string");
  return Object.freeze({ ids: Object.freeze(ids), parse_errors: Object.freeze(parseErrors) });
}

/** Extract the exact thread identity from native `codex queue` success text. */
export function parseCodexQueueResultThreadIds(value) {
  const text = typeof value === "string" ? value : String(value ?? "");
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length !== 1) return Object.freeze({ ids: Object.freeze([]), parse_errors: Object.freeze(["queue success output must contain exactly one line"]) });
  const match = QUEUE_SUCCESS_RE.exec(lines[0]);
  if (!match) return Object.freeze({ ids: Object.freeze([]), parse_errors: Object.freeze(["queue success output did not match the native success shape"]) });
  return Object.freeze({ ids: Object.freeze([match[2]]), parse_errors: Object.freeze([]), submission_ids: Object.freeze([match[1]]) });
}

/** Require the actual continuation result to prove the bound thread identity. */
export function validateCodexContinuationResult({ binding, mode, result } = {}) {
  const validatedBinding = validateCodexContinuationBinding(binding);
  if (!Object.values(CODEX_CONTINUATION_MODE).includes(mode)) fail(CODEX_CONTINUATION_ERRORS.IDENTITY_MISMATCH, "Continuation result mode is invalid.");
  if (result?.ephemeral === true || result?.session_persisted === false) fail(CODEX_CONTINUATION_ERRORS.EPHEMERAL_SESSION, "Continuation result identifies an ephemeral session.");
  if (exitCodeOf(result) !== 0) fail(CODEX_CONTINUATION_ERRORS.EXECUTION_FAILED, "Codex continuation returned a non-zero exit code.");

  const parsed = mode === CODEX_CONTINUATION_MODE.QUEUE && isObject(result) && result.events === undefined
    ? parseCodexQueueResultThreadIds(result.stdout || result.output || "")
    : parseCodexThreadStartedIds(result?.events || result?.stdout || result);
  if (mode === CODEX_CONTINUATION_MODE.RESUME && parsed.parse_errors.length > 0) {
    fail(CODEX_CONTINUATION_ERRORS.IDENTITY_MISMATCH, "Codex resume output was not valid JSONL proof of the bound thread.");
  }
  const ids = [...parsed.ids];
  if (mode === CODEX_CONTINUATION_MODE.QUEUE && isObject(result)) {
    const direct = firstDefined(result.thread_id, result.thread?.thread_id, result.thread?.id);
    if (typeof direct === "string") ids.push(direct);
  }
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length !== 1 || uniqueIds[0] !== validatedBinding.thread_id) {
    fail(CODEX_CONTINUATION_ERRORS.IDENTITY_MISMATCH, "Codex continuation did not prove the exact bound thread identity.");
  }
  return Object.freeze({ status: "ACCEPTED", mode, thread_id: validatedBinding.thread_id });
}

function immutableResult(value) {
  return Object.freeze({ ...value });
}

/**
 * Create a parent-owned, idempotent sender. The process executor is injected in
 * tests; delivery ambiguity is terminal and never retried or rerouted.
 */
export function createCodexContinuationSender({
  binding,
  runtime,
  required_mode = null,
  mode = null,
  require_queue = false,
  runtimeProbe = null,
  probe = null,
  verifyRuntime = verifyCodexRuntimeBinding,
  invoke = invokeCodexProcess,
} = {}) {
  const validatedBinding = validateCodexContinuationBinding(binding);
  const validatedRuntime = validateCodexRuntimeBinding(runtime);
  const records = new Map();

  const verifyRuntimeForSend = async () => {
    const probeFunction = runtimeProbe || probe;
    let observed = null;
    if (probeFunction) {
      try {
        observed = await probeFunction({ ...validatedRuntime, cwd: validatedBinding.working_directory, invoke });
      } catch (error) {
        if (Object.values(CODEX_RUNTIME_ERRORS).includes(error?.code)) throw error;
        throw new CodexContinuationError("Codex runtime probe failed.", CODEX_RUNTIME_ERRORS.PROBE_FAILED);
      }
    }
    if (probeFunction && (observed === null || observed === undefined)) {
      throw new CodexContinuationError("Codex runtime probe returned no evidence.", CODEX_RUNTIME_ERRORS.PROBE_FAILED);
    }
    try {
      return await verifyRuntime(validatedRuntime, { observed });
    } catch (error) {
      if (Object.values(CODEX_RUNTIME_ERRORS).includes(error?.code)) throw error;
      throw new CodexContinuationError("Codex runtime verification failed.", CODEX_RUNTIME_ERRORS.DRIFT);
    }
  };

  const send = async (request) => {
    const validatedRequest = validateCodexContinuationReturn(request, validatedBinding);
    const existing = records.get(validatedRequest.return_id);
    if (existing) {
      if (existing.prompt_sha256 !== validatedRequest.prompt_sha256) {
        fail(CODEX_CONTINUATION_ERRORS.RETURN_CONFLICT, "Continuation return identity was reused with a different prompt.");
      }
      if (existing.status === "COMPLETED") return immutableResult({ status: "IDEMPOTENT", dispatched: false, mode: existing.mode, return_id: validatedRequest.return_id, thread_id: validatedBinding.thread_id });
      if (existing.status === "DELIVERY_UNKNOWN") fail(CODEX_CONTINUATION_ERRORS.DELIVERY_UNKNOWN, "Continuation delivery is ambiguous; automatic reinjection is forbidden.");
      if (existing.status === "REJECTED") fail(existing.error_code || CODEX_CONTINUATION_ERRORS.IDENTITY_MISMATCH, "Continuation was rejected and cannot be retried automatically.");
      fail(CODEX_CONTINUATION_ERRORS.DELIVERY_UNKNOWN, "Continuation is already in flight.");
    }

    const record = { status: "IN_FLIGHT", prompt_sha256: validatedRequest.prompt_sha256, invocation_started: false, mode: null };
    records.set(validatedRequest.return_id, record);
    try {
      await verifyRuntimeForSend();
      const requiredMode = required_mode || mode || (require_queue === true ? CODEX_CONTINUATION_MODE.QUEUE : null);
      if (requiredMode !== null && !Object.values(CODEX_CONTINUATION_MODE).includes(requiredMode)) {
        fail(CODEX_RUNTIME_ERRORS.CAPABILITY_UNAVAILABLE, `Unsupported Codex continuation mode: ${requiredMode}.`);
      }
      const selectedMode = requiredMode
        || (validatedRuntime.capabilities.queue ? CODEX_CONTINUATION_MODE.QUEUE : validatedRuntime.capabilities.resume ? CODEX_CONTINUATION_MODE.RESUME : null);
      if (!selectedMode) fail(CODEX_CONTINUATION_ERRORS.CAPABILITY_UNAVAILABLE, "Codex continuation capability is unavailable.");
      if (validatedRuntime.capabilities[selectedMode] !== true) {
        fail(CODEX_RUNTIME_ERRORS.CAPABILITY_UNAVAILABLE, `Bound Codex runtime lacks required capability: ${selectedMode}.`);
      }
      const invocation = buildCodexContinuationInvocation({ binding: validatedBinding, request: validatedRequest, mode: selectedMode, runtime: validatedRuntime });
      record.mode = selectedMode;
      record.invocation_started = true;
      const rawResult = await invoke(invocation);
      const accepted = validateCodexContinuationResult({ binding: validatedBinding, mode: selectedMode, result: rawResult });
      record.status = "COMPLETED";
      record.result = accepted;
      return immutableResult({ status: "DISPATCHED", dispatched: true, mode: selectedMode, return_id: validatedRequest.return_id, thread_id: validatedBinding.thread_id });
    } catch (error) {
      record.error_code = error?.code || CODEX_CONTINUATION_ERRORS.DELIVERY_UNKNOWN;
      record.status = error?.code === CODEX_CONTINUATION_ERRORS.IDENTITY_MISMATCH
        || error?.code === CODEX_CONTINUATION_ERRORS.EPHEMERAL_SESSION
        || error?.code === CODEX_RUNTIME_ERRORS.REQUIRED
        || error?.code === CODEX_RUNTIME_ERRORS.INVALID
        || error?.code === CODEX_RUNTIME_ERRORS.UNAVAILABLE
        || error?.code === CODEX_RUNTIME_ERRORS.DRIFT
        || error?.code === CODEX_RUNTIME_ERRORS.CAPABILITY_UNAVAILABLE
        || error?.code === CODEX_RUNTIME_ERRORS.PROBE_FAILED
        ? "REJECTED"
        : record.invocation_started ? "DELIVERY_UNKNOWN" : "REJECTED";
      throw error;
    }
  };

  const inspect = (returnId) => {
    const record = records.get(returnId);
    return record ? Object.freeze({ status: record.status, mode: record.mode, error_code: record.error_code || null, prompt_sha256: record.prompt_sha256 }) : null;
  };

  return Object.freeze({ send, dispatch: send, inspect, binding: validatedBinding, runtime: validatedRuntime });
}

export const createCodexContinuationAdapter = createCodexContinuationSender;
