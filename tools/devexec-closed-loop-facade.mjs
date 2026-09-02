import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  createTaskChatBinding,
  getTaskChatReturnTarget,
  validateTaskChatBinding,
} from "./devexec-task-chat-binding.mjs";
import {
  createCodexContinuationBinding,
  createCodexContinuationSender,
  invokeCodexProcess,
  validateCodexContinuationBinding,
} from "./devexec-codex-continuation.mjs";
import {
  createCodexRuntimeBinding,
  probeCodexRuntime,
  validateCodexRuntimeBinding,
  verifyCodexRuntimeBinding,
} from "./devexec-codex-runtime-binding.mjs";
import {
  CLOSED_LOOP_PROTOCOL,
  CLOSED_LOOP_SCHEMA_VERSION,
  createCodexAppServerTurnObserver,
  createClosedLoopOrchestrator,
  validateClosedLoopLimits,
  validateCodexCompletionEvidence,
} from "./devexec-closed-loop.mjs";
import {
  createBoundChatGPTTransport,
  validateLocalRelayDecision,
} from "./devexec-full-relay.mjs";

export const CLOSED_LOOP_ADMISSION_PROTOCOL = "devexec.closed-loop-admission";
export const CLOSED_LOOP_ADMISSION_SCHEMA_VERSION = 1;
export const DEFAULT_CLOSED_LOOP_ADMISSION_ROOT = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "ChatGPTMCPProbe",
  "closed-loop-admissions",
);
export const DEFAULT_LOCAL_RELAY_URL = "http://127.0.0.1:1234/v1";
export const DEFAULT_MCP_CONFIG_PATH = path.join(os.homedir(), ".lmstudio", "mcp.json");
export const DEFAULT_MCP_SERVER_NAME = "chatgpt-web-probe";

export const CLOSED_LOOP_FACADE_ERRORS = Object.freeze({
  REQUIRED: "CLOSED_LOOP_FACADE_REQUIRED",
  INVALID: "CLOSED_LOOP_FACADE_INVALID",
  ADMISSION_INVALID: "CLOSED_LOOP_ADMISSION_INVALID",
  ADMISSION_CONFLICT: "CLOSED_LOOP_ADMISSION_CONFLICT",
  THREAD_INVALID: "CLOSED_LOOP_EXISTING_THREAD_INVALID",
  THREAD_UNPROVEN: "CLOSED_LOOP_EXISTING_THREAD_UNPROVEN",
  RUNTIME_INVALID: "CLOSED_LOOP_RUNTIME_INVALID",
  RELAY_INVALID: "CLOSED_LOOP_RELAY_INVALID",
  MCP_INVALID: "CLOSED_LOOP_MCP_INVALID",
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/i;
const ADMISSION_ID_RE = /^[a-z][a-z0-9_-]{2,127}$/;
const MAX_ADMISSION_BYTES = 512 * 1024;
const MAX_RELAY_RESPONSE_BYTES = 64 * 1024;
const LOCAL_RELAY_RESPONSE_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    protocol: { type: "string" },
    schema_version: { type: "integer" },
    request_id: { type: "string" },
    payload_sha256: { type: "string" },
    action: { type: "string" },
  },
  required: ["protocol", "schema_version", "request_id", "payload_sha256", "action"],
});
const ADMISSION_FIELDS = Object.freeze([
  "protocol",
  "schema_version",
  "admission_id",
  "loop_id",
  "mission_id",
  "task_id",
  "initial_turn_id",
  "task_chat_binding",
  "codex_continuation_binding",
  "codex_runtime_binding",
  "thread_probe",
  "limits",
  "state_dir",
  "admission_root",
  "created_at",
  "updated_at",
]);
const THREAD_PROBE_FIELDS = Object.freeze([
  "thread_id",
  "turn_id",
  "turn_status",
  "source_turn_sha256",
  "causal_proof",
  "verified_at",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requiredText(value, label, code = CLOSED_LOOP_FACADE_ERRORS.REQUIRED) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    const error = new ClosedLoopFacadeError(`${label} must be an exact non-empty string.`, code);
    throw error;
  }
  return value;
}

function optionalText(value, label) {
  if (value === null || value === undefined) return null;
  return requiredText(value, label, CLOSED_LOOP_FACADE_ERRORS.INVALID);
}

function absolutePath(value, label) {
  const text = requiredText(value, label, CLOSED_LOOP_FACADE_ERRORS.REQUIRED);
  if (!(path.isAbsolute(text) || path.win32.isAbsolute(text) || path.posix.isAbsolute(text))) {
    throw new ClosedLoopFacadeError(`${label} must be an absolute path; PATH/default lookup is not allowed.`, CLOSED_LOOP_FACADE_ERRORS.INVALID);
  }
  return /^[A-Za-z]:[\\/]/.test(text) ? path.win32.normalize(text) : path.normalize(text);
}

function uuid(value, label) {
  const text = requiredText(value, label, CLOSED_LOOP_FACADE_ERRORS.REQUIRED);
  if (!UUID_RE.test(text)) throw new ClosedLoopFacadeError(`${label} must be a UUID.`, CLOSED_LOOP_FACADE_ERRORS.INVALID);
  return text;
}

function digest(value, label) {
  const text = requiredText(value, label, CLOSED_LOOP_FACADE_ERRORS.INVALID);
  if (!DIGEST_RE.test(text)) throw new ClosedLoopFacadeError(`${label} must be a sha256 digest.`, CLOSED_LOOP_FACADE_ERRORS.INVALID);
  return text;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isObject(value)) {
    const output = {};
    for (const key of Object.keys(value).sort()) output[key] = stableValue(value[key]);
    return output;
  }
  return value;
}

function canonicalJson(value) {
  const serialized = JSON.stringify(stableValue(value));
  if (serialized === undefined) throw new ClosedLoopFacadeError("Value cannot be serialized as JSON.", CLOSED_LOOP_FACADE_ERRORS.INVALID);
  return serialized;
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value), "utf8").digest("hex")}`;
}

function freeze(value) {
  if (Array.isArray(value)) {
    value.forEach(freeze);
    return Object.freeze(value);
  }
  if (isObject(value)) {
    Object.values(value).forEach(freeze);
    return Object.freeze(value);
  }
  return value;
}

function validateAdmissionId(value) {
  const text = requiredText(value, "admission_id", CLOSED_LOOP_ADMISSION_ERRORS.INVALID);
  if (!ADMISSION_ID_RE.test(text) || text.includes("..")) {
    throw new ClosedLoopFacadeError("admission_id contains unsupported path characters.", CLOSED_LOOP_FACADE_ERRORS.INVALID);
  }
  return text;
}

const CLOSED_LOOP_ADMISSION_ERRORS = CLOSED_LOOP_FACADE_ERRORS;

function regularFile(filePath, label, maxBytes = MAX_ADMISSION_BYTES) {
  let stat;
  try { stat = fs.lstatSync(filePath); } catch (error) {
    throw new ClosedLoopFacadeError(`${label} is unavailable.`, CLOSED_LOOP_FACADE_ERRORS.ADMISSION_INVALID, error);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw new ClosedLoopFacadeError(`${label} must be a bounded regular file.`, CLOSED_LOOP_FACADE_ERRORS.ADMISSION_INVALID);
  }
  return stat;
}

function admissionIdentity(input) {
  const chat = input.task_chat_binding || input.taskChatBinding || { chat_url: input.chat_url, conversation_id: input.conversation_id };
  const continuation = input.codex_continuation_binding || input.codexContinuationBinding || {
    thread_id: input.thread_id,
    working_directory: input.working_directory,
    repo_root: input.repo_root ?? null,
  };
  const runtime = input.codex_runtime_binding || input.codexRuntimeBinding || { executable_path: input.runtime_path };
  return {
    protocol: CLOSED_LOOP_ADMISSION_PROTOCOL,
    schema_version: CLOSED_LOOP_ADMISSION_SCHEMA_VERSION,
    mission_id: input.mission_id,
    task_id: input.task_id,
    initial_turn_id: input.initial_turn_id,
    chat_url: chat.chat_url,
    conversation_id: chat.conversation_id,
    thread_id: continuation.thread_id,
    working_directory: continuation.working_directory,
    repo_root: continuation.repo_root,
    runtime_path: runtime.executable_path,
  };
}

export function computeClosedLoopAdmissionId(input = {}) {
  const text = sha256(canonicalJson(admissionIdentity(input))).slice("sha256:".length);
  return `admit-${text}`;
}

function validateThreadProbe(value, continuation, initialTurn) {
  if (!isObject(value)) throw new ClosedLoopFacadeError("thread_probe must be an object.", CLOSED_LOOP_FACADE_ERRORS.THREAD_INVALID);
  for (const key of Object.keys(value)) if (!THREAD_PROBE_FIELDS.includes(key)) throw new ClosedLoopFacadeError(`Unknown thread_probe field: ${key}.`, CLOSED_LOOP_FACADE_ERRORS.THREAD_INVALID);
  for (const key of THREAD_PROBE_FIELDS) if (!hasOwn(value, key)) throw new ClosedLoopFacadeError(`thread_probe field is missing: ${key}.`, CLOSED_LOOP_FACADE_ERRORS.THREAD_INVALID);
  if (uuid(value.thread_id, "thread_probe.thread_id") !== continuation.thread_id) throw new ClosedLoopFacadeError("thread_probe belongs to a different Codex thread.", CLOSED_LOOP_FACADE_ERRORS.THREAD_INVALID);
  if (uuid(value.turn_id, "thread_probe.turn_id") !== initialTurn) throw new ClosedLoopFacadeError("thread_probe does not prove the requested initial turn.", CLOSED_LOOP_FACADE_ERRORS.THREAD_INVALID);
  if (value.turn_status !== "completed") throw new ClosedLoopFacadeError("thread_probe must prove a completed turn.", CLOSED_LOOP_FACADE_ERRORS.THREAD_UNPROVEN);
  digest(value.source_turn_sha256, "thread_probe.source_turn_sha256");
  requiredText(value.causal_proof, "thread_probe.causal_proof", CLOSED_LOOP_FACADE_ERRORS.THREAD_INVALID);
  requiredText(value.verified_at, "thread_probe.verified_at", CLOSED_LOOP_FACADE_ERRORS.THREAD_INVALID);
  return {
    thread_id: value.thread_id,
    turn_id: value.turn_id,
    turn_status: value.turn_status,
    source_turn_sha256: value.source_turn_sha256,
    causal_proof: value.causal_proof,
    verified_at: value.verified_at,
  };
}

function exactKeys(value, fields, label) {
  if (!isObject(value)) throw new ClosedLoopFacadeError(`${label} must be an object.`, CLOSED_LOOP_FACADE_ERRORS.ADMISSION_INVALID);
  for (const field of fields) if (!hasOwn(value, field)) throw new ClosedLoopFacadeError(`${label} field is missing: ${field}.`, CLOSED_LOOP_FACADE_ERRORS.ADMISSION_INVALID);
  for (const field of Object.keys(value)) if (!fields.includes(field)) throw new ClosedLoopFacadeError(`${label} contains an unknown field: ${field}.`, CLOSED_LOOP_FACADE_ERRORS.ADMISSION_INVALID);
}

/** Validate one persisted admission without resolving any aliases or defaults. */
export function validateClosedLoopAdmission(value) {
  exactKeys(value, ADMISSION_FIELDS, "closed-loop admission");
  if (value.protocol !== CLOSED_LOOP_ADMISSION_PROTOCOL || value.schema_version !== CLOSED_LOOP_ADMISSION_SCHEMA_VERSION) {
    throw new ClosedLoopFacadeError("Unsupported closed-loop admission protocol or schema_version.", CLOSED_LOOP_FACADE_ERRORS.ADMISSION_INVALID);
  }
  const admissionId = validateAdmissionId(value.admission_id);
  const loopId = requiredText(value.loop_id, "loop_id", CLOSED_LOOP_FACADE_ERRORS.ADMISSION_INVALID);
  const missionId = requiredText(value.mission_id, "mission_id", CLOSED_LOOP_FACADE_ERRORS.ADMISSION_INVALID);
  const taskId = requiredText(value.task_id, "task_id", CLOSED_LOOP_FACADE_ERRORS.ADMISSION_INVALID);
  const initialTurnId = uuid(value.initial_turn_id, "initial_turn_id");
  const chat = validateTaskChatBinding(value.task_chat_binding);
  const continuation = validateCodexContinuationBinding(value.codex_continuation_binding);
  const runtime = validateCodexRuntimeBinding(value.codex_runtime_binding);
  if (chat.mission_id !== missionId || continuation.mission_id !== missionId || chat.task_id !== taskId || continuation.task_id !== taskId) {
    throw new ClosedLoopFacadeError("Admission mission/task identity does not match its bindings.", CLOSED_LOOP_FACADE_ERRORS.ADMISSION_INVALID);
  }
  if (runtime.capabilities.queue !== true || !runtime.required_capabilities.includes("queue")) {
    throw new ClosedLoopFacadeError("Admission requires the bound native Codex queue capability.", CLOSED_LOOP_FACADE_ERRORS.RUNTIME_INVALID);
  }
  const threadProbe = validateThreadProbe(value.thread_probe, continuation, initialTurnId);
  const limits = validateClosedLoopLimits(value.limits);
  const stateDir = absolutePath(value.state_dir, "state_dir");
  const admissionRoot = absolutePath(value.admission_root, "admission_root");
  const createdAt = requiredText(value.created_at, "created_at", CLOSED_LOOP_FACADE_ERRORS.ADMISSION_INVALID);
  const updatedAt = requiredText(value.updated_at, "updated_at", CLOSED_LOOP_FACADE_ERRORS.ADMISSION_INVALID);
  return freeze({
    protocol: CLOSED_LOOP_ADMISSION_PROTOCOL,
    schema_version: CLOSED_LOOP_ADMISSION_SCHEMA_VERSION,
    admission_id: admissionId,
    loop_id: loopId,
    mission_id: missionId,
    task_id: taskId,
    initial_turn_id: initialTurnId,
    task_chat_binding: chat,
    codex_continuation_binding: continuation,
    codex_runtime_binding: runtime,
    thread_probe: threadProbe,
    limits,
    state_dir: stateDir,
    admission_root: admissionRoot,
    created_at: createdAt,
    updated_at: updatedAt,
  });
}

function admissionPath(root, admissionId) {
  const base = absolutePath(root, "admission_root");
  const id = validateAdmissionId(admissionId);
  return path.join(base, "admissions-v1", `${id}.json`);
}

export function closedLoopAdmissionPath(admissionId, { admissionRoot = DEFAULT_CLOSED_LOOP_ADMISSION_ROOT } = {}) {
  return admissionPath(admissionRoot, admissionId);
}

export function loadClosedLoopAdmission(reference, { admissionRoot = DEFAULT_CLOSED_LOOP_ADMISSION_ROOT } = {}) {
  const text = requiredText(reference, "admission", CLOSED_LOOP_FACADE_ERRORS.REQUIRED);
  const looksLikePath = path.isAbsolute(text) || path.win32.isAbsolute(text) || path.posix.isAbsolute(text) || text.includes("/") || text.includes("\\");
  const filePath = looksLikePath ? absolutePath(text, "admission path") : admissionPath(admissionRoot, text.replace(/\.json$/i, ""));
  regularFile(filePath, "admission file");
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch (error) { throw new ClosedLoopFacadeError("Admission file is not valid JSON.", CLOSED_LOOP_FACADE_ERRORS.ADMISSION_INVALID, error); }
  const admission = validateClosedLoopAdmission(parsed);
  if (admission.admission_id !== path.basename(filePath, ".json")) {
    throw new ClosedLoopFacadeError("Admission file name does not match admission_id.", CLOSED_LOOP_FACADE_ERRORS.ADMISSION_INVALID);
  }
  return admission;
}

function sameAdmissionIdentity(left, right) {
  return canonicalJson({
    admission_id: left.admission_id,
    mission_id: left.mission_id,
    task_id: left.task_id,
    initial_turn_id: left.initial_turn_id,
    task_chat_binding: left.task_chat_binding,
    codex_continuation_binding: left.codex_continuation_binding,
    codex_runtime_binding: left.codex_runtime_binding,
    limits: left.limits,
    state_dir: left.state_dir,
  }) === canonicalJson({
    admission_id: right.admission_id,
    mission_id: right.mission_id,
    task_id: right.task_id,
    initial_turn_id: right.initial_turn_id,
    task_chat_binding: right.task_chat_binding,
    codex_continuation_binding: right.codex_continuation_binding,
    codex_runtime_binding: right.codex_runtime_binding,
    limits: right.limits,
    state_dir: right.state_dir,
  });
}

function existingOrWrite(admission, filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    const fd = fs.openSync(filePath, "wx");
    try { fs.writeFileSync(fd, `${canonicalJson(admission)}\n`, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return { admission, created: true, file: filePath };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = loadClosedLoopAdmission(filePath);
    if (!sameAdmissionIdentity(admission, existing)) throw new ClosedLoopFacadeError("Admission identity conflicts with the persisted admission.", CLOSED_LOOP_FACADE_ERRORS.ADMISSION_CONFLICT);
    return { admission: existing, created: false, file: filePath };
  }
}

function normalizeThreadProbe(value, continuation, initialTurnId, now) {
  let evidence;
  try { evidence = validateCodexCompletionEvidence(value, continuation.thread_id); }
  catch (error) { throw new ClosedLoopFacadeError("Existing Codex thread/turn completion could not be proven.", CLOSED_LOOP_FACADE_ERRORS.THREAD_UNPROVEN, error); }
  if (evidence.turn_id !== initialTurnId || evidence.turn_status !== "completed") {
    throw new ClosedLoopFacadeError("Existing Codex probe did not prove the exact requested completed turn.", CLOSED_LOOP_FACADE_ERRORS.THREAD_UNPROVEN);
  }
  return {
    thread_id: continuation.thread_id,
    turn_id: initialTurnId,
    turn_status: "completed",
    source_turn_sha256: evidence.source_turn_sha256,
    causal_proof: evidence.causal_proof,
    verified_at: now(),
  };
}

async function probeExistingCodexThread({ continuation, runtime, initialTurnId, timeoutMs, threadProbe, now }) {
  if (typeof threadProbe === "function") return normalizeThreadProbe(await threadProbe({ continuation, runtime, initial_turn_id: initialTurnId, timeout_ms: timeoutMs }), continuation, initialTurnId, now);
  const observer = createCodexAppServerTurnObserver({
    continuationBinding: continuation,
    runtimeBinding: runtime,
    turnTimeoutMs: timeoutMs,
    requestTimeoutMs: Math.min(timeoutMs, 30000),
    compactHistory: true,
  });
  try {
    const completion = await observer.wait({ thread_id: continuation.thread_id, turn_id: initialTurnId, timeout_ms: timeoutMs });
    return normalizeThreadProbe(completion, continuation, initialTurnId, now);
  } finally {
    observer.close();
  }
}

/**
 * Admit an already persisted Codex task/thread. Every identity is explicit;
 * this function never consults target registries, current chat, PATH, --last,
 * or fuzzy session discovery.
 */
export async function admitExistingCodexTask(input = {}) {
  if (!isObject(input)) throw new ClosedLoopFacadeError("Admission input is required.", CLOSED_LOOP_FACADE_ERRORS.REQUIRED);
  const missionId = requiredText(input.mission_id || input.missionId, "mission_id");
  const taskId = requiredText(input.task_id || input.taskId, "task_id");
  const threadId = uuid(input.thread_id || input.threadId, "thread_id");
  const initialTurnId = uuid(input.initial_turn_id || input.initialTurnId, "initial_turn_id");
  const chatUrl = requiredText(input.chat_url || input.chatUrl, "chat_url");
  const runtimePath = absolutePath(input.runtime_path || input.runtimePath || input.executable_path, "runtime_path");
  const workingDirectory = absolutePath(input.working_directory || input.workingDirectory || input.cwd, "working_directory");
  const repoRoot = input.repo_root === undefined && input.repoRoot === undefined ? null : absolutePath(input.repo_root || input.repoRoot, "repo_root");
  const admissionRoot = absolutePath(input.admission_root || input.admissionRoot || DEFAULT_CLOSED_LOOP_ADMISSION_ROOT, "admission_root");
  const limits = validateClosedLoopLimits(input.limits || {
    max_rounds: input.max_rounds ?? input.maxRounds ?? 8,
    turn_timeout_ms: input.turn_timeout_ms ?? input.turnTimeoutMs,
    chatgpt_timeout_ms: input.chatgpt_timeout_ms ?? input.chatGPTTimeoutMs,
    local_relay_timeout_ms: input.local_relay_timeout_ms ?? input.localRelayTimeoutMs,
    wall_clock_budget_ms: input.wall_clock_budget_ms ?? input.wallClockBudgetMs,
  });
  const requestedAdmissionId = input.admission_id || input.admissionId || null;
  if (requestedAdmissionId !== null) validateAdmissionId(requestedAdmissionId);

  const chat = createTaskChatBinding({
    mission_id: missionId,
    task_id: taskId,
    chat_url: chatUrl,
    source: input.chat_source || "explicit-admission-url",
    source_alias: null,
  });
  const continuation = createCodexContinuationBinding({
    mission_id: missionId,
    task_id: taskId,
    thread_id: threadId,
    working_directory: workingDirectory,
    repo_root: repoRoot,
    session_persisted: true,
    bound_at: input.bound_at || new Date().toISOString(),
  });

  // If a deterministic admission already exists, load it before probing or
  // rebinding the native runtime. A changed runtime remains drift, not a new
  // implicit admission.
  const candidateId = requestedAdmissionId || computeClosedLoopAdmissionId({
    mission_id: missionId,
    task_id: taskId,
    initial_turn_id: initialTurnId,
    task_chat_binding: chat,
    codex_continuation_binding: continuation,
    codex_runtime_binding: { executable_path: runtimePath },
  });
  const candidateFile = admissionPath(admissionRoot, candidateId);
  if (fs.existsSync(candidateFile)) {
    const existing = loadClosedLoopAdmission(candidateFile);
    if (existing.mission_id !== missionId || existing.task_id !== taskId || existing.initial_turn_id !== initialTurnId || existing.task_chat_binding.chat_url !== chat.chat_url || existing.codex_continuation_binding.thread_id !== threadId || existing.codex_continuation_binding.working_directory !== workingDirectory || existing.codex_runtime_binding.executable_path.toLowerCase() !== runtimePath.toLowerCase()) {
      throw new ClosedLoopFacadeError("Existing admission conflicts with the explicit task/thread/runtime identity.", CLOSED_LOOP_FACADE_ERRORS.ADMISSION_CONFLICT);
    }
    return Object.freeze({ admission: existing, created: false, file: candidateFile, thread_identity: { thread_id: existing.codex_continuation_binding.thread_id, initial_turn_id: existing.initial_turn_id, probe_turn_id: existing.thread_probe.turn_id, source_turn_sha256: existing.thread_probe.source_turn_sha256 } });
  }

  let runtime;
  if (input.runtime_binding !== undefined || input.runtimeBinding !== undefined) {
    runtime = validateCodexRuntimeBinding(input.runtime_binding || input.runtimeBinding);
    if (runtime.executable_path.toLowerCase() !== runtimePath.toLowerCase()) throw new ClosedLoopFacadeError("runtime_binding executable does not match runtime_path.", CLOSED_LOOP_FACADE_ERRORS.RUNTIME_INVALID);
  } else {
    const probe = await (input.runtime_probe || input.runtimeProbe || probeCodexRuntime)({
      executable_path: runtimePath,
      launch_args: input.launch_args || input.launchArgs || [],
      cwd: workingDirectory,
      fingerprint_files: input.fingerprint_files || input.fingerprintFiles,
    });
    if (!isObject(probe) || !isObject(probe.capabilities) || probe.capabilities.queue !== true) {
      throw new ClosedLoopFacadeError("Explicit native Codex runtime does not prove queue capability.", CLOSED_LOOP_FACADE_ERRORS.RUNTIME_INVALID);
    }
    runtime = createCodexRuntimeBinding({
      ...probe,
      executable_path: runtimePath,
      launch_args: input.launch_args || input.launchArgs || probe.launch_args || [],
      required_capabilities: ["queue"],
      provenance: input.runtime_provenance || "explicit-admission-runtime",
      bound_at: input.runtime_bound_at || new Date().toISOString(),
    });
  }
  if (runtime.capabilities.queue !== true) throw new ClosedLoopFacadeError("Bound runtime queue capability is required.", CLOSED_LOOP_FACADE_ERRORS.RUNTIME_INVALID);

  const now = input.now || (() => new Date().toISOString());
  const threadProbe = await probeExistingCodexThread({
    continuation,
    runtime,
    initialTurnId,
    timeoutMs: Number(input.thread_probe_timeout_ms || input.threadProbeTimeoutMs || 60000),
    threadProbe: input.thread_probe || input.threadProbe,
    now,
  });
  const admissionId = requestedAdmissionId || candidateId;
  const admission = validateClosedLoopAdmission({
    protocol: CLOSED_LOOP_ADMISSION_PROTOCOL,
    schema_version: CLOSED_LOOP_ADMISSION_SCHEMA_VERSION,
    admission_id: admissionId,
    loop_id: input.loop_id || input.loopId || `loop-${admissionId.slice("admit-".length)}`,
    mission_id: missionId,
    task_id: taskId,
    initial_turn_id: initialTurnId,
    task_chat_binding: chat,
    codex_continuation_binding: continuation,
    codex_runtime_binding: runtime,
    thread_probe: threadProbe,
    limits,
    state_dir: input.state_dir || input.stateDir || path.join(admissionRoot, admissionId, "state"),
    admission_root: admissionRoot,
    created_at: now(),
    updated_at: now(),
  });
  const written = existingOrWrite(admission, candidateFile);
  return Object.freeze({
    ...written,
    thread_identity: {
      thread_id: admission.codex_continuation_binding.thread_id,
      initial_turn_id: admission.initial_turn_id,
      probe_turn_id: admission.thread_probe.turn_id,
      source_turn_sha256: admission.thread_probe.source_turn_sha256,
    },
  });
}

function localLoopbackUrl(value, label) {
  const text = requiredText(value, label, CLOSED_LOOP_FACADE_ERRORS.RELAY_INVALID).replace(/\/$/, "");
  let parsed;
  try { parsed = new URL(text); } catch (error) { throw new ClosedLoopFacadeError(`${label} must be a valid loopback HTTP URL.`, CLOSED_LOOP_FACADE_ERRORS.RELAY_INVALID, error); }
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname.toLowerCase())) throw new ClosedLoopFacadeError(`${label} must use a loopback HTTP URL.`, CLOSED_LOOP_FACADE_ERRORS.RELAY_INVALID);
  return text;
}

function responseContent(body) {
  if (!isObject(body) || !Array.isArray(body.choices) || body.choices.length !== 1 || !isObject(body.choices[0]?.message)) throw new ClosedLoopFacadeError("Local Model RELAY response has no single chat completion.", CLOSED_LOOP_FACADE_ERRORS.RELAY_INVALID);
  const content = body.choices[0].message.content;
  if (typeof content !== "string" || !content.trim()) throw new ClosedLoopFacadeError("Local Model RELAY response content is empty.", CLOSED_LOOP_FACADE_ERRORS.RELAY_INVALID);
  if (Buffer.byteLength(content, "utf8") > MAX_RELAY_RESPONSE_BYTES) throw new ClosedLoopFacadeError("Local Model RELAY response exceeds the bounded evidence limit.", CLOSED_LOOP_FACADE_ERRORS.RELAY_INVALID);
  try { return JSON.parse(content); }
  catch (error) { throw new ClosedLoopFacadeError("Local Model RELAY did not return exactly one JSON decision envelope.", CLOSED_LOOP_FACADE_ERRORS.RELAY_INVALID, error); }
}

/**
 * OpenAI-compatible loopback adapter for the Local Model RELAY leg. The model
 * sees only the hash/action envelope; it never receives target, thread, path,
 * command, or prompt bytes.
 */
export function createHttpLocalRelayAdapter({ baseUrl = DEFAULT_LOCAL_RELAY_URL, model, fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  const url = localLoopbackUrl(baseUrl, "local relay URL");
  const selectedModel = requiredText(model, "local relay model", CLOSED_LOOP_FACADE_ERRORS.RELAY_INVALID);
  if (typeof fetchImpl !== "function") throw new ClosedLoopFacadeError("A fetch implementation is required for Local Model RELAY.", CLOSED_LOOP_FACADE_ERRORS.RELAY_INVALID);
  return Object.freeze({
    decide: async (input = {}) => {
      if (!isObject(input) || input.mode !== "RELAY" || typeof input.request_id !== "string" || typeof input.payload_sha256 !== "string" || typeof input.action_expected !== "string") {
        throw new ClosedLoopFacadeError("Local Model RELAY request shape is invalid.", CLOSED_LOOP_FACADE_ERRORS.RELAY_INVALID);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("local relay timeout")), Math.max(1, Number(timeoutMs) || 30000));
      let response;
      try {
        response = await fetchImpl(`${url}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            model: selectedModel,
            temperature: 0,
            max_tokens: 256,
            // LM Studio's OpenAI-compatible server accepts json_schema (not
            // json_object) and Qwen 3.5 otherwise spends the whole bound on
            // hidden reasoning without emitting the hash-only decision.
            reasoning_effort: "none",
            response_format: {
              type: "json_schema",
              json_schema: { name: "devexec_local_relay_decision", schema: LOCAL_RELAY_RESPONSE_SCHEMA, strict: true },
            },
            messages: [
              { role: "system", content: "You are a strict Local Model RELAY gate. Return exactly one JSON object with keys protocol, schema_version, request_id, payload_sha256, action. Echo request_id, payload_sha256, and action_expected as action. Never add fields, prose, markdown, targets, threads, paths, commands, or prompt bytes." },
              { role: "user", content: JSON.stringify({ protocol: input.protocol, schema_version: input.schema_version, mode: input.mode, request_id: input.request_id, payload_sha256: input.payload_sha256, action_expected: input.action_expected }) },
            ],
          }),
        });
        const raw = await response.text();
        if (!response.ok) throw new ClosedLoopFacadeError(`Local Model RELAY HTTP ${response.status}.`, CLOSED_LOOP_FACADE_ERRORS.RELAY_INVALID);
        if (Buffer.byteLength(raw, "utf8") > MAX_RELAY_RESPONSE_BYTES) throw new ClosedLoopFacadeError("Local Model RELAY HTTP response is too large.", CLOSED_LOOP_FACADE_ERRORS.RELAY_INVALID);
        let body;
        try { body = JSON.parse(raw); } catch (error) { throw new ClosedLoopFacadeError("Local Model RELAY HTTP response is not JSON.", CLOSED_LOOP_FACADE_ERRORS.RELAY_INVALID, error); }
        return validateLocalRelayDecision(responseContent(body), { request_id: input.request_id, payload_sha256: input.payload_sha256, action: input.action_expected });
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

function readMcpConfig(configPath) {
  const file = absolutePath(configPath, "mcp_config");
  regularFile(file, "MCP config", 128 * 1024);
  let config;
  try { config = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { throw new ClosedLoopFacadeError("MCP config is not valid JSON.", CLOSED_LOOP_FACADE_ERRORS.MCP_INVALID, error); }
  const server = config?.mcpServers?.[DEFAULT_MCP_SERVER_NAME];
  if (!isObject(server) || typeof server.command !== "string" || !server.command.trim() || (server.args !== undefined && !Array.isArray(server.args))) {
    throw new ClosedLoopFacadeError(`MCP server ${DEFAULT_MCP_SERVER_NAME} is unavailable or malformed.`, CLOSED_LOOP_FACADE_ERRORS.MCP_INVALID);
  }
  return { file, server };
}

/** Connect the existing ChatGPT MCP bridge, while the exact URL remains binding-owned. */
export async function connectBoundChatGPTTransport({ taskChatBinding, mcpConfigPath = DEFAULT_MCP_CONFIG_PATH, timeoutMinutes = 30, clientName = "devexec-closed-loop-facade" } = {}) {
  const binding = validateTaskChatBinding(taskChatBinding);
  const { server } = readMcpConfig(mcpConfigPath);
  const client = new Client({ name: clientName, version: "1" });
  const env = {
    ...process.env,
    ...(isObject(server.env) ? server.env : {}),
    // Keep the bridge's legacy environment harmless; every call also carries
    // target_url/expected_conversation_id through createBoundChatGPTTransport.
    CHATGPT_MCP_CHAT_URL: binding.chat_url,
    DEV_EXEC_TARGET_ID: binding.conversation_id,
    DEV_EXEC_TARGET_SOURCE: "closed-loop-admission",
    CHATGPT_MCP_TRANSPORT_RUN_ID: `CLOSED-LOOP-${binding.binding_id.slice(-24)}`,
  };
  const transport = new StdioClientTransport({ command: server.command, args: server.args || [], env });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    if (!Array.isArray(listed?.tools) || !listed.tools.some((tool) => tool?.name === "chatgpt_reply")) throw new ClosedLoopFacadeError("chatgpt_reply is unavailable in the bound MCP bridge.", CLOSED_LOOP_FACADE_ERRORS.MCP_INVALID);
  } catch (error) {
    try { await client.close(); } catch {}
    if (error instanceof ClosedLoopFacadeError) throw error;
    throw new ClosedLoopFacadeError("Could not connect to the bound ChatGPT MCP bridge.", CLOSED_LOOP_FACADE_ERRORS.MCP_INVALID, error);
  }
  const bound = createBoundChatGPTTransport({ callTool: (tool, meta) => client.callTool(tool, undefined, { timeout: Math.max(1, Number(timeoutMinutes) || 30) * 60 * 1000, maxTotalTimeout: Math.max(1, Number(timeoutMinutes) || 30) * 60 * 1000 }), taskChatBinding: binding, timeoutMinutes });
  return Object.freeze({
    transport: bound,
    client,
    close: async () => { try { await client.close(); } catch {} },
    target: getTaskChatReturnTarget(binding),
  });
}

function evidenceFromRun(admission, result, state) {
  const history = Array.isArray(result?.history) ? result.history : Array.isArray(state?.history) ? state.history : [];
  const sameThread = history.every((entry) => entry && typeof entry.source_turn_id === "string") && admission.codex_continuation_binding.thread_id === admission.thread_probe.thread_id;
  return {
    status: result?.status || state?.phase || null,
    loop_id: admission.loop_id,
    mission_id: admission.mission_id,
    task_id: admission.task_id,
    thread_id: admission.codex_continuation_binding.thread_id,
    conversation_id: admission.task_chat_binding.conversation_id,
    task_chat_binding_id: admission.task_chat_binding.binding_id,
    codex_continuation_binding_id: admission.codex_continuation_binding.binding_id,
    codex_runtime_binding_id: admission.codex_runtime_binding.binding_id,
    initial_turn_id: admission.initial_turn_id,
    admitted_probe_turn_id: admission.thread_probe.turn_id,
    history,
    same_thread_identity: sameThread,
    queue_submissions: history.map((entry) => ({ submission_id: entry.submission_id || null, resulting_turn_id: entry.resulting_turn_id || null, thread_id: admission.codex_continuation_binding.thread_id })),
  };
}

/** Run one admitted bounded loop using the existing implementation seams. */
export async function runAdmittedClosedLoop({ admission: inputAdmission, admissionReference, admissionRoot, observer, localRelay, localModel, chatgptTransport, codexSender, invokeCodex, runtimeProbe, limits, mcpConfigPath, relayUrl, relayModel, ownerId, now } = {}) {
  const admission = validateClosedLoopAdmission(inputAdmission || loadClosedLoopAdmission(admissionReference, { admissionRoot }));
  const selectedLimits = validateClosedLoopLimits(limits || admission.limits);
  const resolvedLocalRelay = localRelay || localModel || createHttpLocalRelayAdapter({ baseUrl: relayUrl || process.env.DEV_EXEC_LOCAL_RELAY_URL || DEFAULT_LOCAL_RELAY_URL, model: relayModel || process.env.DEV_EXEC_LOCAL_RELAY_MODEL || "qwen/qwen3.5-4b", timeoutMs: selectedLimits.local_relay_timeout_ms });
  let chatConnection = null;
  let resolvedObserver = observer;
  let resolvedSender = codexSender;
  if (!resolvedObserver) resolvedObserver = createCodexAppServerTurnObserver({ continuationBinding: admission.codex_continuation_binding, runtimeBinding: admission.codex_runtime_binding, turnTimeoutMs: selectedLimits.turn_timeout_ms, requestTimeoutMs: Math.min(selectedLimits.turn_timeout_ms, 30000), compactHistory: true });
  if (!resolvedSender) resolvedSender = createCodexContinuationSender({ binding: admission.codex_continuation_binding, runtime: admission.codex_runtime_binding, required_mode: "queue", require_queue: true, runtimeProbe: runtimeProbe || probeCodexRuntime, verifyRuntime: verifyCodexRuntimeBinding, invoke: invokeCodex || invokeCodexProcess });
  let resolvedChat = chatgptTransport;
  try {
    if (!resolvedChat) {
      chatConnection = await connectBoundChatGPTTransport({ taskChatBinding: admission.task_chat_binding, mcpConfigPath: mcpConfigPath || process.env.DEV_EXEC_MCP_CONFIG || DEFAULT_MCP_CONFIG_PATH, timeoutMinutes: Math.max(1, Math.ceil(selectedLimits.chatgpt_timeout_ms / 60000)) });
      resolvedChat = chatConnection.transport;
    }
    const orchestrator = createClosedLoopOrchestrator({
      loop_id: admission.loop_id,
      taskChatBinding: admission.task_chat_binding,
      codexContinuationBinding: admission.codex_continuation_binding,
      codexRuntimeBinding: admission.codex_runtime_binding,
      initial_turn_id: admission.initial_turn_id,
      stateDir: admission.state_dir,
      observer: resolvedObserver,
      localRelay: resolvedLocalRelay,
      chatgptTransport: resolvedChat,
      codexSender: resolvedSender,
      invokeCodex: invokeCodex || invokeCodexProcess,
      runtimeProbe: runtimeProbe || probeCodexRuntime,
      verifyRuntime: verifyCodexRuntimeBinding,
      limits: selectedLimits,
      owner_id: ownerId,
      now: now || (() => new Date().toISOString()),
    });
    try {
      const result = await orchestrator.run();
      const state = orchestrator.inspect();
      return Object.freeze({ result, state, evidence: evidenceFromRun(admission, result, state), admission });
    } finally {
      orchestrator.close();
    }
  } finally {
    if (chatConnection) await chatConnection.close();
    if (!observer) resolvedObserver?.close?.();
  }
}

export class ClosedLoopFacadeError extends Error {
  constructor(message, code = CLOSED_LOOP_FACADE_ERRORS.INVALID, cause = undefined) {
    super(message);
    this.name = "ClosedLoopFacadeError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

export const CLOSED_LOOP_ADMISSION_IDENTITY = Object.freeze({ protocol: CLOSED_LOOP_ADMISSION_PROTOCOL, schema_version: CLOSED_LOOP_ADMISSION_SCHEMA_VERSION, closed_loop_protocol: CLOSED_LOOP_PROTOCOL, closed_loop_schema_version: CLOSED_LOOP_SCHEMA_VERSION });
