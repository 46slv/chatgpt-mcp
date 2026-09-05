import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getTaskChatReturnTarget,
  validateTaskChatBinding,
  validateTaskChatRelayReport,
} from "./devexec-task-chat-binding.mjs";
import {
  CODEX_CONTINUATION_ERRORS,
  CODEX_CONTINUATION_MODE,
  createCodexContinuationReturn,
  createCodexContinuationSender,
  validateCodexContinuationBinding,
} from "./devexec-codex-continuation.mjs";
import {
  CODEX_RUNTIME_ERRORS,
  validateCodexRuntimeBinding,
} from "./devexec-codex-runtime-binding.mjs";

export const FULL_RELAY_PROTOCOL = "devexec.full-relay";
export const FULL_RELAY_SCHEMA_VERSION = 1;
export const LOCAL_RELAY_DECISION_PROTOCOL = "devexec.local-relay-decision";
export const LOCAL_RELAY_DECISION_SCHEMA_VERSION = 1;
export const LOCAL_RELAY_MODE = "RELAY";
export const CODEX_PROMPT_PROTOCOL = "devexec.codex-prompt";
export const CODEX_PROMPT_SCHEMA_VERSION = 1;
export const CONVERSATION_LEASE_PROTOCOL = "devexec.full-relay-conversation-lease";
export const CONVERSATION_LEASE_SCHEMA_VERSION = 1;

export const FULL_RELAY_STATES = Object.freeze({
  PREPARED: "PREPARED",
  WAITING_FOR_CONVERSATION_SLOT: "WAITING_FOR_CONVERSATION_SLOT",
  CHATGPT_IN_FLIGHT: "CHATGPT_IN_FLIGHT",
  CHATGPT_RESPONSE_RECEIVED: "CHATGPT_RESPONSE_RECEIVED",
  LOCAL_RETURN_APPROVED: "LOCAL_RETURN_APPROVED",
  CODEX_IN_FLIGHT: "CODEX_IN_FLIGHT",
  COMPLETED: "COMPLETED",
  // `COMPLETED` is retained for the historical one-round meaning (the
  // exact Codex queue return was accepted). `COMPLETE` is the distinct
  // semantic terminal decision made by the ChatGPT Supervisor.
  COMPLETE: "COMPLETE",
  STOPPED: "STOPPED",
  NEEDS_HUMAN: "NEEDS_HUMAN",
  DELIVERY_UNKNOWN: "DELIVERY_UNKNOWN",
  REJECTED: "REJECTED",
});

export const FULL_RELAY_ERRORS = Object.freeze({
  REQUIRED: "FULL_RELAY_REQUIRED",
  INVALID: "FULL_RELAY_INVALID",
  IDENTITY_MISMATCH: "FULL_RELAY_IDENTITY_MISMATCH",
  REPORT_CONFLICT: "FULL_RELAY_REPORT_CONFLICT",
  STATE_INVALID: "FULL_RELAY_STATE_INVALID",
  STATE_BUSY: "FULL_RELAY_STATE_BUSY",
  LOCAL_RELAY_REQUIRED: "LOCAL_RELAY_REQUIRED",
  LOCAL_RELAY_INVALID: "LOCAL_RELAY_DECISION_INVALID",
  LOCAL_RELAY_HASH_MISMATCH: "LOCAL_RELAY_HASH_MISMATCH",
  LOCAL_RELAY_ACTION_MISMATCH: "LOCAL_RELAY_ACTION_MISMATCH",
  LOCAL_RELAY_UNCERTAIN: "LOCAL_RELAY_UNCERTAIN",
  CHATGPT_TRANSPORT_REQUIRED: "CHATGPT_TRANSPORT_REQUIRED",
  CHATGPT_DELIVERY_UNKNOWN: "CHATGPT_DELIVERY_UNKNOWN",
  CHATGPT_RESPONSE_INVALID: "CHATGPT_RESPONSE_INVALID",
  CHATGPT_RESPONSE_CORRELATION: "CHATGPT_RESPONSE_CORRELATION_MISMATCH",
  CONVERSATION_SLOT_HELD: "CONVERSATION_SLOT_HELD",
  CONVERSATION_LEASE_INVALID: "CONVERSATION_LEASE_INVALID",
  CODEX_TRANSPORT_REQUIRED: "CODEX_TRANSPORT_REQUIRED",
  CODEX_DELIVERY_UNKNOWN: "CODEX_DELIVERY_UNKNOWN",
  CODEX_RUNTIME_REQUIRED: CODEX_RUNTIME_ERRORS.REQUIRED,
  CODEX_RUNTIME_INVALID: CODEX_RUNTIME_ERRORS.INVALID,
  CODEX_RUNTIME_UNAVAILABLE: CODEX_RUNTIME_ERRORS.UNAVAILABLE,
  CODEX_RUNTIME_DRIFT: CODEX_RUNTIME_ERRORS.DRIFT,
  CODEX_RUNTIME_CAPABILITY: CODEX_RUNTIME_ERRORS.CAPABILITY_UNAVAILABLE,
});

export const RELAY_STATE = FULL_RELAY_STATES;
export const FULL_RELAY_STATE = FULL_RELAY_STATES;

export const LOCAL_RELAY_ACTIONS = Object.freeze({
  FORWARD_REPORT: "FORWARD_REPORT",
  RETURN_CODEX_PROMPT: "RETURN_CODEX_PROMPT",
});
export const LOCAL_RELAY_ACTION = LOCAL_RELAY_ACTIONS;
export const LOCAL_RELAY_ACTIONS_ALLOWED = LOCAL_RELAY_ACTIONS;

export const RESPONSE_DECISIONS = Object.freeze({ CONTINUE: "CONTINUE", COMPLETE: "COMPLETE", STOP: "STOP", NEEDS_HUMAN: "NEEDS_HUMAN" });
export const CODEX_PROMPT_DECISIONS = RESPONSE_DECISIONS;

const CORE_ID_FIELDS = Object.freeze([
  "mission_id",
  "task_id",
  "task_chat_binding_id",
  "codex_continuation_binding_id",
  "codex_runtime_binding_id",
  "codex_runtime_fingerprint",
  "relay_request_id",
  "report_sha256",
]);

const STATE_FIELDS = new Set([
  "protocol",
  "schema_version",
  "phase",
  "mission_id",
  "task_id",
  "conversation_id",
  "task_chat_binding_id",
  "codex_continuation_binding_id",
  "codex_runtime_binding_id",
  "codex_runtime_fingerprint",
  "relay_request_id",
  "report_sha256",
  "report_payload",
  "report_payload_sha256",
  "chatgpt_payload",
  "chatgpt_payload_sha256",
  "chatgpt_response",
  "chatgpt_response_sha256",
  "codex_prompt_sha256",
  "codex_return_id",
  "codex_result",
  "lease_nonce",
  "lease_holder",
  "error_code",
  "error_message",
  "terminal_reason",
  "created_at",
  "updated_at",
]);

const LEASE_FIELDS = Object.freeze([
  "protocol",
  "schema_version",
  "key_sha256",
  "task_id",
  "relay_request_id",
  "owner_id",
  "nonce",
  "acquired_at",
]);

const MAX_STATE_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 8192;
const MAX_PAYLOAD_BYTES = 64 * 1024;

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredText(value, label, code = FULL_RELAY_ERRORS.REQUIRED) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new FullRelayError(`${label} must be an exact non-empty string.`, code);
  }
  return value;
}

function digestText(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value), "utf8").digest("hex")}`;
}

function digestBytes(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function isDigest(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/i.test(value);
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

/** Serialize JSON with sorted object keys for deterministic parent-owned hashes. */
export function canonicalJson(value) {
  const serialized = JSON.stringify(stableValue(value));
  if (serialized === undefined) throw new FullRelayError("Value cannot be serialized as JSON.", FULL_RELAY_ERRORS.INVALID);
  return serialized;
}

export const stableJson = canonicalJson;

export function sha256(value) {
  return digestBytes(value);
}

export function hashJson(value) {
  return digestText(canonicalJson(value));
}

function parseJsonValue(value, code, label) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new FullRelayError(`${label} is not valid JSON.`, code, error);
  }
}

function exactKeys(value, required, label, code = FULL_RELAY_ERRORS.INVALID) {
  if (!isObject(value)) throw new FullRelayError(`${label} must be an object.`, code);
  const expected = new Set(required);
  for (const field of required) {
    if (!hasOwn(value, field)) throw new FullRelayError(`${label} field is missing: ${field}.`, code);
  }
  for (const field of Object.keys(value)) {
    if (!expected.has(field)) throw new FullRelayError(`${label} contains an unknown field: ${field}.`, code);
  }
}

function cloneFrozen(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneFrozen));
  if (isObject(value)) {
    const clone = {};
    for (const [key, item] of Object.entries(value)) clone[key] = cloneFrozen(item);
    return Object.freeze(clone);
  }
  return value;
}

export class FullRelayError extends Error {
  constructor(message, code = FULL_RELAY_ERRORS.INVALID, cause = undefined) {
    super(message);
    this.name = "FullRelayError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function fail(code, message, cause = undefined) {
  throw new FullRelayError(message, code, cause);
}

function boundedText(value, label, { required = false, maxBytes = MAX_TEXT_BYTES } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(FULL_RELAY_ERRORS.REQUIRED, `${label} is required.`);
    return null;
  }
  if (typeof value !== "string") fail(FULL_RELAY_ERRORS.INVALID, `${label} must be text.`);
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > maxBytes) fail(FULL_RELAY_ERRORS.INVALID, `${label} exceeds the bounded relay payload size.`);
  return value;
}

function validateCoreIdentity(value, expected = null) {
  if (!isObject(value)) fail(FULL_RELAY_ERRORS.REQUIRED, "Relay identity is required.");
  for (const field of CORE_ID_FIELDS) requiredText(value[field], field);
  if (!isDigest(value.report_sha256)) fail(FULL_RELAY_ERRORS.INVALID, "report_sha256 must be a sha256 digest.");
  if (!isDigest(value.codex_runtime_fingerprint)) fail(FULL_RELAY_ERRORS.INVALID, "codex_runtime_fingerprint must be a sha256 digest.");
  if (expected) {
    for (const field of CORE_ID_FIELDS) {
      if (value[field] !== expected[field]) fail(FULL_RELAY_ERRORS.IDENTITY_MISMATCH, `${field} does not match the parent identity.`);
    }
  }
  return value;
}

/** Build the only decision envelope a Local Model RELAY adapter may return. */
export function createLocalRelayDecision({ request_id, payload_sha256, action } = {}) {
  return validateLocalRelayDecision({
    protocol: LOCAL_RELAY_DECISION_PROTOCOL,
    schema_version: LOCAL_RELAY_DECISION_SCHEMA_VERSION,
    request_id,
    payload_sha256,
    action,
  });
}

/** Validate a hash-only RELAY decision; targets, threads, paths and commands are never accepted. */
export function validateLocalRelayDecision(value, { request_id, payload_sha256, action } = {}) {
  const parsed = parseJsonValue(value, FULL_RELAY_ERRORS.LOCAL_RELAY_INVALID, "Local relay decision");
  exactKeys(parsed, ["protocol", "schema_version", "request_id", "payload_sha256", "action"], "Local relay decision", FULL_RELAY_ERRORS.LOCAL_RELAY_INVALID);
  if (parsed.protocol !== LOCAL_RELAY_DECISION_PROTOCOL || parsed.schema_version !== LOCAL_RELAY_DECISION_SCHEMA_VERSION) {
    fail(FULL_RELAY_ERRORS.LOCAL_RELAY_INVALID, "Unsupported Local Model RELAY protocol or schema_version.");
  }
  requiredText(parsed.request_id, "request_id", FULL_RELAY_ERRORS.LOCAL_RELAY_INVALID);
  if (!isDigest(parsed.payload_sha256)) fail(FULL_RELAY_ERRORS.LOCAL_RELAY_INVALID, "Local relay payload_sha256 is invalid.");
  requiredText(parsed.action, "action", FULL_RELAY_ERRORS.LOCAL_RELAY_INVALID);
  if (request_id !== undefined && parsed.request_id !== request_id) fail(FULL_RELAY_ERRORS.IDENTITY_MISMATCH, "Local relay request_id does not match the parent request.");
  if (payload_sha256 !== undefined && parsed.payload_sha256 !== payload_sha256) fail(FULL_RELAY_ERRORS.LOCAL_RELAY_HASH_MISMATCH, "Local relay payload hash does not match the parent payload.");
  if (action !== undefined && parsed.action !== action) fail(FULL_RELAY_ERRORS.LOCAL_RELAY_ACTION_MISMATCH, "Local relay action does not match the required leg.");
  if (!Object.values(LOCAL_RELAY_ACTIONS).includes(parsed.action)) fail(FULL_RELAY_ERRORS.LOCAL_RELAY_ACTION_MISMATCH, "Local relay action is not allowed.");
  return cloneFrozen(parsed);
}

export const validateRelayDecision = validateLocalRelayDecision;

function reportTextFields(report) {
  const output = {};
  for (const field of ["completion", "situation", "status", "summary"]) {
    if (hasOwn(report, field)) output[field] = boundedText(report[field], `report.${field}`);
  }
  return output;
}

function reportEvidenceFields(report) {
  const output = {};
  // These are parent-produced evidence fields.  They are copied byte-for-byte
  // into the ChatGPT payload after a bounded canonical-size check; the Local
  // Model RELAY still receives hashes only and never sees or rewrites them.
  const allowed = [
    "goal",
    "current_task",
    "branch",
    "head",
    "changed_files",
    "validation",
    "diff_evidence",
    "unresolved_blockers",
    "codex_self_report",
    "parent_verifiable_evidence",
    "source_identity",
    "source_thread_id",
    "source_turn_id",
    "source_turn_sha256",
    "source_causal_proof",
  ];
  for (const field of allowed) {
    if (!hasOwn(report, field)) continue;
    const value = report[field];
    if (typeof value === "string") output[field] = boundedText(value, `report.${field}`, { maxBytes: MAX_TEXT_BYTES });
    else {
      let serialized;
      try { serialized = canonicalJson(value); }
      catch (error) { fail(FULL_RELAY_ERRORS.INVALID, `report.${field} cannot be serialized.`, error); }
      if (Buffer.byteLength(serialized, "utf8") > 24 * 1024) fail(FULL_RELAY_ERRORS.INVALID, `report.${field} exceeds the bounded evidence size.`);
      output[field] = value;
    }
  }
  return output;
}

function reportPayload({ report, identity }) {
  const payload = {
    protocol: "devexec.full-relay-report",
    schema_version: 1,
    instruction: "Return exactly one devexec.codex-prompt JSON envelope with the matching correlation fields. Use decision CONTINUE with prompt, COMPLETE, STOP, or NEEDS_HUMAN; do not add fields.",
    correlation: {
      mission_id: identity.mission_id,
      task_id: identity.task_id,
      relay_request_id: identity.relay_request_id,
      report_sha256: identity.report_sha256,
    },
    report: { ...reportTextFields(report), ...reportEvidenceFields(report) },
  };
  const serialized = canonicalJson(payload);
  if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) fail(FULL_RELAY_ERRORS.INVALID, "Relay report payload exceeds the bounded size.");
  return serialized;
}

function validateBindings({ taskChatBinding, chatBinding, chat, codexContinuationBinding, continuationBinding, continuation, codexRuntimeBinding, runtimeBinding, runtime } = {}) {
  const validatedChat = validateTaskChatBinding(taskChatBinding || chatBinding || chat);
  const validatedContinuation = validateCodexContinuationBinding(codexContinuationBinding || continuationBinding || continuation);
  const validatedRuntime = validateCodexRuntimeBinding(codexRuntimeBinding || runtimeBinding || runtime);
  if (validatedChat.mission_id !== validatedContinuation.mission_id || validatedChat.task_id !== validatedContinuation.task_id) {
    fail(FULL_RELAY_ERRORS.IDENTITY_MISMATCH, "Task chat and Codex continuation bindings do not share mission/task identity.");
  }
  if (!validatedRuntime.capabilities.queue) {
    fail(FULL_RELAY_ERRORS.CODEX_RUNTIME_CAPABILITY, "Full Relay requires queue capability on the bound Codex runtime; no fallback is allowed.");
  }
  return { chat: validatedChat, continuation: validatedContinuation, runtime: validatedRuntime };
}

/** Build a deterministic parent-owned request from the three immutable bindings and report. */
export function createRelayRequest({
  taskChatBinding,
  chatBinding,
  codexContinuationBinding,
  continuationBinding,
  codexRuntimeBinding,
  runtimeBinding,
  report,
  relay_request_id,
  relayRequestId,
} = {}) {
  const { chat, continuation, runtime } = validateBindings({
    taskChatBinding,
    chatBinding,
    codexContinuationBinding,
    continuationBinding,
    codexRuntimeBinding,
    runtimeBinding,
  });
  const validatedReport = validateTaskChatRelayReport(report, chat);
  const reportSha = hashJson(validatedReport);
  const stableIdentity = {
    mission_id: chat.mission_id,
    task_id: chat.task_id,
    task_chat_binding_id: chat.binding_id,
    codex_continuation_binding_id: continuation.binding_id,
    codex_runtime_binding_id: runtime.binding_id,
    codex_runtime_fingerprint: runtime.runtime_fingerprint,
  };
  const requestedId = relay_request_id || relayRequestId;
  const requestId = requestedId === undefined ? digestText(canonicalJson(stableIdentity)) : requiredText(requestedId, "relay_request_id");
  const identity = { ...stableIdentity, relay_request_id: requestId, report_sha256: reportSha };
  const payload = reportPayload({ report: validatedReport, identity });
  return cloneFrozen({
    protocol: FULL_RELAY_PROTOCOL,
    schema_version: FULL_RELAY_SCHEMA_VERSION,
    ...identity,
    report: validatedReport,
    report_payload: payload,
    report_payload_sha256: digestBytes(payload),
  });
}

export const buildRelayRequest = createRelayRequest;
export const createFullRelayRequest = createRelayRequest;

/** Validate a previously persisted request without resolving any target or runtime. */
export function validateRelayRequest(value, bindings = {}) {
  if (!isObject(value)) fail(FULL_RELAY_ERRORS.INVALID, "Relay request must be an object.");
  if (value.protocol !== FULL_RELAY_PROTOCOL || value.schema_version !== FULL_RELAY_SCHEMA_VERSION) {
    fail(FULL_RELAY_ERRORS.INVALID, "Unsupported full relay protocol or schema_version.");
  }
  for (const field of [...CORE_ID_FIELDS, "report", "report_payload", "report_payload_sha256"]) {
    if (!hasOwn(value, field)) fail(FULL_RELAY_ERRORS.INVALID, `Relay request field is missing: ${field}.`);
  }
  validateCoreIdentity(value);
  const { chat, continuation, runtime } = validateBindings(bindings);
  const expected = {
    mission_id: chat.mission_id,
    task_id: chat.task_id,
    task_chat_binding_id: chat.binding_id,
    codex_continuation_binding_id: continuation.binding_id,
    codex_runtime_binding_id: runtime.binding_id,
    codex_runtime_fingerprint: runtime.runtime_fingerprint,
    relay_request_id: value.relay_request_id,
    report_sha256: value.report_sha256,
  };
  validateCoreIdentity(value, expected);
  const report = validateTaskChatRelayReport(value.report, chat);
  if (hashJson(report) !== value.report_sha256) fail(FULL_RELAY_ERRORS.REPORT_CONFLICT, "Relay request report hash does not match report bytes.");
  if (digestBytes(value.report_payload) !== value.report_payload_sha256) fail(FULL_RELAY_ERRORS.INVALID, "Relay request report payload hash does not match bytes.");
  return cloneFrozen({ ...value, report });
}

export const validateFullRelayRequest = validateRelayRequest;

function randomId(prefix) {
  return `${prefix}-${crypto.randomBytes(12).toString("hex")}`;
}

function safeMkdir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function writeFsync(fd, content) {
  try {
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function readBounded(filePath, maxBytes = MAX_STATE_BYTES) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) fail(FULL_RELAY_ERRORS.STATE_INVALID, `State file is not a bounded regular file: ${filePath}.`);
  return fs.readFileSync(filePath, "utf8");
}

function atomicWriteJson(filePath, value) {
  const directory = path.dirname(filePath);
  safeMkdir(directory);
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const content = `${canonicalJson(value)}\n`;
  try {
    const fd = fs.openSync(temporary, "wx");
    writeFsync(fd, content);
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function stateFileName(requestId) {
  return `${digestText(requestId).slice("sha256:".length)}.json`;
}

function validateStateRecord(value) {
  if (!isObject(value)) fail(FULL_RELAY_ERRORS.STATE_INVALID, "Relay state must be an object.");
  for (const field of ["protocol", "schema_version", "phase", ...CORE_ID_FIELDS, "conversation_id", "report_payload", "report_payload_sha256", "created_at", "updated_at"]) {
    if (!hasOwn(value, field)) fail(FULL_RELAY_ERRORS.STATE_INVALID, `Relay state field is missing: ${field}.`);
  }
  for (const field of Object.keys(value)) {
    if (!STATE_FIELDS.has(field)) fail(FULL_RELAY_ERRORS.STATE_INVALID, `Unknown relay state field: ${field}.`);
  }
  if (value.protocol !== FULL_RELAY_PROTOCOL || value.schema_version !== FULL_RELAY_SCHEMA_VERSION) fail(FULL_RELAY_ERRORS.STATE_INVALID, "Unsupported relay state protocol or schema_version.");
  if (!Object.values(FULL_RELAY_STATES).includes(value.phase)) fail(FULL_RELAY_ERRORS.STATE_INVALID, "Relay state phase is invalid.");
  validateCoreIdentity(value);
  requiredText(value.conversation_id, "conversation_id", FULL_RELAY_ERRORS.STATE_INVALID);
  requiredText(value.report_payload, "report_payload", FULL_RELAY_ERRORS.STATE_INVALID);
  if (!isDigest(value.report_payload_sha256) || digestBytes(value.report_payload) !== value.report_payload_sha256) fail(FULL_RELAY_ERRORS.STATE_INVALID, "Relay state report payload hash is invalid.");
  if (value.chatgpt_response !== undefined || value.chatgpt_response_sha256 !== undefined) {
    if (!isObject(value.chatgpt_response) || !isDigest(value.chatgpt_response_sha256) || hashJson(value.chatgpt_response) !== value.chatgpt_response_sha256) {
      fail(FULL_RELAY_ERRORS.STATE_INVALID, "Relay state ChatGPT response hash is invalid.");
    }
  }
  if (value.codex_prompt_sha256 !== undefined && value.codex_prompt_sha256 !== null && !isDigest(value.codex_prompt_sha256)) {
    fail(FULL_RELAY_ERRORS.STATE_INVALID, "Relay state Codex prompt hash is invalid.");
  }
  if (value.chatgpt_response?.decision === RESPONSE_DECISIONS.CONTINUE && value.codex_prompt_sha256 !== undefined && value.codex_prompt_sha256 !== null) {
    if (typeof value.chatgpt_response.prompt !== "string" || digestBytes(value.chatgpt_response.prompt) !== value.codex_prompt_sha256) {
      fail(FULL_RELAY_ERRORS.STATE_INVALID, "Relay state Codex prompt hash does not match the correlated response prompt.");
    }
  }
  if (value.phase === FULL_RELAY_STATES.COMPLETE) {
    if (!isObject(value.chatgpt_response) || value.chatgpt_response.decision !== RESPONSE_DECISIONS.COMPLETE || !isDigest(value.chatgpt_response_sha256) || hashJson(value.chatgpt_response) !== value.chatgpt_response_sha256) {
      fail(FULL_RELAY_ERRORS.STATE_INVALID, "Semantic COMPLETE state requires the exact correlated COMPLETE response.");
    }
    try {
      validateCodexPromptResponse(value.chatgpt_response, {
        mission_id: value.mission_id,
        task_id: value.task_id,
        relay_request_id: value.relay_request_id,
        report_sha256: value.report_sha256,
      });
    } catch (error) {
      fail(FULL_RELAY_ERRORS.STATE_INVALID, "Semantic COMPLETE state response correlation is invalid.", error);
    }
  }
  return value;
}

function compareRequestToState(request, state) {
  for (const field of CORE_ID_FIELDS) {
    if (request[field] !== state[field]) {
      if (field === "report_sha256") fail(FULL_RELAY_ERRORS.REPORT_CONFLICT, "Relay identity was reused with a different report.");
      fail(FULL_RELAY_ERRORS.IDENTITY_MISMATCH, `${field} does not match persisted relay state.`);
    }
  }
  if (request.report_payload_sha256 !== state.report_payload_sha256) fail(FULL_RELAY_ERRORS.REPORT_CONFLICT, "Relay identity was reused with a different report payload.");
}

/** Parent-owned per-request state store. It uses exclusive creation and locked atomic updates. */
export function createRelayStateStore({ stateDir, directory, now = () => new Date().toISOString() } = {}) {
  const root = stateDir || directory;
  if (root === undefined) fail(FULL_RELAY_ERRORS.REQUIRED, "A parent-owned relay stateDir is required.");
  const roundsDir = path.join(path.resolve(root), "rounds-v1");
  safeMkdir(roundsDir);

  const filePathFor = (requestId) => path.join(roundsDir, stateFileName(requestId));
  const load = (requestId) => {
    const filePath = filePathFor(requiredText(requestId, "relay_request_id"));
    if (!fs.existsSync(filePath)) return null;
    let parsed;
    try { parsed = JSON.parse(readBounded(filePath)); }
    catch (error) { fail(FULL_RELAY_ERRORS.STATE_INVALID, "Relay state JSON is invalid.", error); }
    return validateStateRecord(parsed);
  };

  const create = (request) => {
    const validated = request;
    if (!isObject(validated)) fail(FULL_RELAY_ERRORS.REQUIRED, "Relay request is required.");
    validateCoreIdentity(validated);
    requiredText(validated.report_payload, "report_payload");
    if (!isDigest(validated.report_payload_sha256) || digestBytes(validated.report_payload) !== validated.report_payload_sha256) fail(FULL_RELAY_ERRORS.INVALID, "Relay request report payload hash is invalid.");
    if (!isObject(validated.report) || !isObject(validated.report.return_target)) fail(FULL_RELAY_ERRORS.INVALID, "Relay request report return_target is required.");
    const filePath = filePathFor(validated.relay_request_id);
  const state = {
      protocol: FULL_RELAY_PROTOCOL,
      schema_version: FULL_RELAY_SCHEMA_VERSION,
      phase: FULL_RELAY_STATES.PREPARED,
      mission_id: validated.mission_id,
      task_id: validated.task_id,
      conversation_id: validated.task_chat_binding_id ? validated.report.return_target.conversation_id : "",
      task_chat_binding_id: validated.task_chat_binding_id,
      codex_continuation_binding_id: validated.codex_continuation_binding_id,
      codex_runtime_binding_id: validated.codex_runtime_binding_id,
      codex_runtime_fingerprint: validated.codex_runtime_fingerprint,
      relay_request_id: validated.relay_request_id,
      report_sha256: validated.report_sha256,
      report_payload: validated.report_payload,
      report_payload_sha256: validated.report_payload_sha256,
      created_at: now(),
      updated_at: now(),
    };
    try {
      const fd = fs.openSync(filePath, "wx");
      writeFsync(fd, `${canonicalJson(state)}\n`);
      return Object.freeze(state);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = load(validated.relay_request_id);
      if (!existing) fail(FULL_RELAY_ERRORS.STATE_INVALID, "Relay state disappeared during duplicate admission.");
      compareRequestToState(validated, existing);
      return existing;
    }
  };

  const lockPathFor = (requestId) => `${filePathFor(requestId)}.lock`;

  const update = (requestId, patchOrUpdater, { expectedPhase = null } = {}) => {
    const current = load(requestId);
    if (!current) fail(FULL_RELAY_ERRORS.STATE_INVALID, "Relay state is missing; success cannot be inferred.");
    const lockPath = lockPathFor(requestId);
    let fd;
    try { fd = fs.openSync(lockPath, "wx"); }
    catch (error) {
      if (error?.code === "EEXIST") throw new FullRelayError("Relay state is being updated by another process.", FULL_RELAY_ERRORS.STATE_BUSY);
      throw error;
    }
    try {
      const lockedCurrent = load(requestId);
      if (!lockedCurrent) fail(FULL_RELAY_ERRORS.STATE_INVALID, "Relay state disappeared while locked.");
      if (expectedPhase !== null) {
        const allowed = Array.isArray(expectedPhase) ? expectedPhase : [expectedPhase];
        if (!allowed.includes(lockedCurrent.phase)) return lockedCurrent;
      }
      const patch = typeof patchOrUpdater === "function" ? patchOrUpdater(lockedCurrent) : patchOrUpdater;
      if (!isObject(patch)) fail(FULL_RELAY_ERRORS.INVALID, "Relay state update must be an object.");
      const next = {
        ...lockedCurrent,
        ...patch,
        updated_at: now(),
      };
      validateStateRecord(next);
      atomicWriteJson(filePathFor(requestId), next);
      return Object.freeze(next);
    } finally {
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(lockPath); } catch {}
    }
  };

  return Object.freeze({
    stateDir: path.resolve(root),
    roundsDir,
    filePathFor,
    load,
    create,
    update,
  });
}

export const createFullRelayStateStore = createRelayStateStore;
export const createRelayRoundStateStore = createRelayStateStore;

/** File-backed conversation single-flight arbitration. It is not a general job queue. */
export function createConversationArbitrator({ stateDir, directory, now = () => new Date().toISOString(), owner_id, ownerId } = {}) {
  const root = stateDir || directory;
  if (root === undefined) fail(FULL_RELAY_ERRORS.REQUIRED, "A parent-owned conversation arbitration directory is required.");
  const leaseDir = path.join(path.resolve(root), "conversations-v1");
  safeMkdir(leaseDir);
  const owner = requiredText(owner_id || ownerId || `${os.hostname()}:${process.pid}`, "owner_id");

  const leasePathFor = (conversationId) => path.join(leaseDir, `${digestText(requiredText(conversationId, "conversation_id")).slice("sha256:".length)}.json`);
  const parseLease = (filePath) => {
    let parsed;
    try { parsed = JSON.parse(readBounded(filePath, 128 * 1024)); }
    catch (error) { return { status: "INVALID", error }; }
    try {
      exactKeys(parsed, LEASE_FIELDS, "Conversation lease", FULL_RELAY_ERRORS.CONVERSATION_LEASE_INVALID);
      if (parsed.protocol !== CONVERSATION_LEASE_PROTOCOL || parsed.schema_version !== CONVERSATION_LEASE_SCHEMA_VERSION) throw new Error("protocol");
      if (!isDigest(parsed.key_sha256)) throw new Error("key_sha256");
      requiredText(parsed.task_id, "task_id", FULL_RELAY_ERRORS.CONVERSATION_LEASE_INVALID);
      requiredText(parsed.relay_request_id, "relay_request_id", FULL_RELAY_ERRORS.CONVERSATION_LEASE_INVALID);
      requiredText(parsed.owner_id, "owner_id", FULL_RELAY_ERRORS.CONVERSATION_LEASE_INVALID);
      requiredText(parsed.nonce, "nonce", FULL_RELAY_ERRORS.CONVERSATION_LEASE_INVALID);
      requiredText(parsed.acquired_at, "acquired_at", FULL_RELAY_ERRORS.CONVERSATION_LEASE_INVALID);
      return { status: "VALID", record: parsed };
    } catch (error) {
      return { status: "INVALID", error };
    }
  };

  const acquire = ({ conversation_id, conversationId, task_id, taskId, relay_request_id, relayRequestId } = {}) => {
    conversation_id = conversation_id || conversationId;
    task_id = task_id || taskId;
    relay_request_id = relay_request_id || relayRequestId;
    requiredText(conversation_id, "conversation_id");
    requiredText(task_id, "task_id");
    requiredText(relay_request_id, "relay_request_id");
    const filePath = leasePathFor(conversation_id);
    const record = {
      protocol: CONVERSATION_LEASE_PROTOCOL,
      schema_version: CONVERSATION_LEASE_SCHEMA_VERSION,
      key_sha256: digestText(conversation_id),
      task_id,
      relay_request_id,
      owner_id: owner,
      nonce: randomId("lease"),
      acquired_at: now(),
    };
    try {
      const fd = fs.openSync(filePath, "wx");
      writeFsync(fd, `${canonicalJson(record)}\n`);
      const handle = Object.freeze({ filePath, record: cloneFrozen(record), release: () => release(handle) });
      return Object.freeze({ status: "ACQUIRED", handle, holder: cloneFrozen(record) });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const parsed = parseLease(filePath);
      if (parsed.status !== "VALID") {
        return Object.freeze({ status: "LEASE_INVALID", code: FULL_RELAY_ERRORS.CONVERSATION_LEASE_INVALID });
      }
      if (parsed.record.relay_request_id === relay_request_id) {
        const handle = Object.freeze({ filePath, record: cloneFrozen(parsed.record), release: () => release(handle) });
        return Object.freeze({ status: "ACQUIRED", reentrant: true, handle, holder: cloneFrozen(parsed.record) });
      }
      return Object.freeze({
        status: "WAITING_FOR_CONVERSATION_SLOT",
        holder: cloneFrozen(parsed.record),
        code: FULL_RELAY_ERRORS.CONVERSATION_SLOT_HELD,
      });
    }
  };

  const release = (handle) => {
    if (!handle || !isObject(handle.record) || typeof handle.filePath !== "string") fail(FULL_RELAY_ERRORS.CONVERSATION_LEASE_INVALID, "Conversation lease handle is invalid.");
    const parsed = parseLease(handle.filePath);
    if (parsed.status !== "VALID" || canonicalJson(parsed.record) !== canonicalJson(handle.record)) {
      fail(FULL_RELAY_ERRORS.CONVERSATION_LEASE_INVALID, "Conversation lease no longer matches the parent-owned handle.");
    }
    try { fs.unlinkSync(handle.filePath); }
    catch (error) {
      if (error?.code !== "ENOENT") fail(FULL_RELAY_ERRORS.CONVERSATION_LEASE_INVALID, "Conversation lease could not be released.", error);
    }
    return Object.freeze({ status: "RELEASED", relay_request_id: handle.record.relay_request_id });
  };

  const inspect = (conversation_id) => {
    const filePath = leasePathFor(conversation_id);
    if (!fs.existsSync(filePath)) return null;
    const parsed = parseLease(filePath);
    return parsed.status === "VALID" ? cloneFrozen(parsed.record) : Object.freeze({ status: "INVALID" });
  };

  return Object.freeze({ leaseDir, owner_id: owner, leasePathFor, acquire, release, inspect });
}

export const createRelayConversationArbitrator = createConversationArbitrator;
export const createConversationLease = createConversationArbitrator;
export const createConversationLeaseManager = createConversationArbitrator;
export const createRelayArbitrator = createConversationArbitrator;

function resolveAdapter(adapter, labels, requiredCode) {
  if (typeof adapter === "function") return adapter;
  if (isObject(adapter)) {
    for (const label of labels) if (typeof adapter[label] === "function") return adapter[label].bind(adapter);
  }
  fail(requiredCode, `${labels.join("/")} adapter is required.`);
}

/** Execute one bounded hash-only Local Model RELAY authorization. */
export async function runLocalRelayGate({ localModel, localRelay, request_id, payload, payload_sha256, action, timeoutMs = 30000 } = {}) {
  const adapter = localRelay || localModel;
  if (payload === undefined && payload_sha256 === undefined) fail(FULL_RELAY_ERRORS.REQUIRED, "Local relay payload or payload_sha256 is required.");
  const expectedHash = payload_sha256 || digestBytes(payload);
  if (!isDigest(expectedHash)) fail(FULL_RELAY_ERRORS.LOCAL_RELAY_INVALID, "Local relay payload_sha256 is invalid.");
  if (payload !== undefined && digestBytes(payload) !== expectedHash) fail(FULL_RELAY_ERRORS.LOCAL_RELAY_HASH_MISMATCH, "Local relay payload bytes do not match payload_sha256.");
  requiredText(request_id, "request_id");
  if (!Object.values(LOCAL_RELAY_ACTIONS).includes(action)) fail(FULL_RELAY_ERRORS.LOCAL_RELAY_ACTION_MISMATCH, "Local relay action is not allowed.");
  const input = Object.freeze({
    protocol: LOCAL_RELAY_DECISION_PROTOCOL,
    schema_version: LOCAL_RELAY_DECISION_SCHEMA_VERSION,
    mode: LOCAL_RELAY_MODE,
    request_id,
    payload_sha256: expectedHash,
    action_expected: action,
  });
  const result = await callBoundAdapter(adapter, input, timeoutMs, FULL_RELAY_ERRORS.LOCAL_RELAY_UNCERTAIN, "Local Model RELAY");
  return validateLocalRelayDecision(result, { request_id, payload_sha256: expectedHash, action });
}

export const executeLocalRelayGate = runLocalRelayGate;

export function createLocalRelayGate({ localModel, localRelay, timeoutMs = 30000 } = {}) {
  resolveAdapter(localRelay || localModel, ["decide", "relay", "authorize"], FULL_RELAY_ERRORS.LOCAL_RELAY_REQUIRED);
  return Object.freeze((input = {}) => runLocalRelayGate({ ...input, localModel, localRelay, timeoutMs }));
}

async function callBoundAdapter(adapter, input, timeoutMs, unknownCode, label) {
  const fn = resolveAdapter(adapter, label === "Local Model RELAY" ? ["decide", "relay", "authorize"] : label === "ChatGPT" ? ["send", "reply", "chatgpt_reply"] : ["send", "dispatch"], unknownCode);
  let timer;
  let timedOut = false;
  try {
    const pending = Promise.resolve().then(() => fn(input));
    const timeout = Number(timeoutMs);
    if (Number.isFinite(timeout) && timeout > 0) {
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new FullRelayError(`${label} adapter timed out.`, unknownCode));
        }, timeout);
      });
      return await Promise.race([pending, timeoutPromise]);
    }
    return await pending;
  } catch (error) {
    if (error?.code === unknownCode) throw error;
    throw new FullRelayError(`${label} adapter delivery is uncertain.`, unknownCode, error);
  } finally {
    if (timer) clearTimeout(timer);
    if (timedOut) void 0;
  }
}

function responseEnvelope(value) {
  const parsed = parseJsonValue(value, FULL_RELAY_ERRORS.CHATGPT_RESPONSE_INVALID, "ChatGPT response");
  if (Array.isArray(parsed)) fail(FULL_RELAY_ERRORS.CHATGPT_RESPONSE_INVALID, "Multiple ChatGPT response envelopes are not accepted.");
  if (!isObject(parsed)) fail(FULL_RELAY_ERRORS.CHATGPT_RESPONSE_INVALID, "ChatGPT response envelope must be an object.");
  if (hasOwn(parsed, "responses") || hasOwn(parsed, "envelopes") || hasOwn(parsed, "messages")) fail(FULL_RELAY_ERRORS.CHATGPT_RESPONSE_INVALID, "Multiple ChatGPT response envelopes are not accepted.");
  return parsed;
}

/** Create the strict correlated response envelope used by deterministic adapters/tests. */
export function createCodexPromptResponse({
  mission_id,
  task_id,
  relay_request_id,
  report_sha256,
  decision,
  prompt,
  prompt_id,
} = {}) {
  const base = { protocol: CODEX_PROMPT_PROTOCOL, schema_version: CODEX_PROMPT_SCHEMA_VERSION, mission_id, task_id, relay_request_id, report_sha256, decision };
  if (decision === RESPONSE_DECISIONS.CONTINUE) base.prompt = prompt;
  if (prompt_id !== undefined) base.prompt_id = prompt_id;
  return validateCodexPromptResponse(base);
}

/** Validate exactly one ChatGPT response and never associate it by arrival order. */
export function validateCodexPromptResponse(value, expected = {}) {
  const parsed = responseEnvelope(value);
  const common = ["protocol", "schema_version", "mission_id", "task_id", "relay_request_id", "report_sha256", "decision"];
  const allowed = parsed.decision === RESPONSE_DECISIONS.CONTINUE ? [...common, "prompt", "prompt_id"] : [...common, "prompt"];
  if (!isObject(parsed)) fail(FULL_RELAY_ERRORS.CHATGPT_RESPONSE_INVALID, "ChatGPT response envelope must be an object.");
  for (const field of common) if (!hasOwn(parsed, field)) fail(FULL_RELAY_ERRORS.CHATGPT_RESPONSE_INVALID, `ChatGPT response field is missing: ${field}.`);
  if (parsed.decision === RESPONSE_DECISIONS.CONTINUE && !hasOwn(parsed, "prompt")) fail(FULL_RELAY_ERRORS.CHATGPT_RESPONSE_INVALID, "ChatGPT response field is missing: prompt.");
  for (const field of Object.keys(parsed)) if (!allowed.includes(field)) fail(FULL_RELAY_ERRORS.CHATGPT_RESPONSE_INVALID, `ChatGPT response contains an unknown field: ${field}.`);
  if (parsed.protocol !== CODEX_PROMPT_PROTOCOL || parsed.schema_version !== CODEX_PROMPT_SCHEMA_VERSION) fail(FULL_RELAY_ERRORS.CHATGPT_RESPONSE_INVALID, "Unsupported ChatGPT response protocol or schema_version.");
  requiredText(parsed.mission_id, "mission_id", FULL_RELAY_ERRORS.CHATGPT_RESPONSE_INVALID);
  requiredText(parsed.task_id, "task_id", FULL_RELAY_ERRORS.CHATGPT_RESPONSE_INVALID);
  requiredText(parsed.relay_request_id, "relay_request_id", FULL_RELAY_ERRORS.CHATGPT_RESPONSE_INVALID);
  if (!isDigest(parsed.report_sha256)) fail(FULL_RELAY_ERRORS.CHATGPT_RESPONSE_INVALID, "ChatGPT response report_sha256 is invalid.");
  if (!Object.values(RESPONSE_DECISIONS).includes(parsed.decision)) fail(FULL_RELAY_ERRORS.CHATGPT_RESPONSE_INVALID, "ChatGPT response decision is not allowed.");
  if (parsed.decision === RESPONSE_DECISIONS.CONTINUE) {
    boundedText(parsed.prompt, "prompt", { required: true });
    if (!parsed.prompt.trim()) fail(FULL_RELAY_ERRORS.CHATGPT_RESPONSE_INVALID, "CONTINUE requires a non-blank continuation prompt.");
  }
  if (parsed.decision !== RESPONSE_DECISIONS.CONTINUE && hasOwn(parsed, "prompt") && parsed.prompt !== null) fail(FULL_RELAY_ERRORS.CHATGPT_RESPONSE_INVALID, "Terminal ChatGPT decisions cannot carry a continuation prompt.");
  if (hasOwn(parsed, "prompt_id")) requiredText(parsed.prompt_id, "prompt_id", FULL_RELAY_ERRORS.CHATGPT_RESPONSE_INVALID);
  for (const field of ["mission_id", "task_id", "relay_request_id", "report_sha256"]) {
    if (expected[field] !== undefined && parsed[field] !== expected[field]) fail(FULL_RELAY_ERRORS.CHATGPT_RESPONSE_CORRELATION, `ChatGPT response ${field} does not match the parent request.`);
  }
  return cloneFrozen(parsed);
}

export const validateChatGPTResponse = validateCodexPromptResponse;

/**
 * Adapt an MCP callTool function to the exact task-bound ChatGPT transport.
 * The URL and conversation ID are captured from the validated binding and are
 * checked again on every send; no alias/default/current-chat lookup exists in
 * this adapter.
 */
export function createBoundChatGPTTransport({ callTool, taskChatBinding, chatBinding, timeoutMinutes = 30 } = {}) {
  if (typeof callTool !== "function") fail(FULL_RELAY_ERRORS.CHATGPT_TRANSPORT_REQUIRED, "callTool is required for the bound ChatGPT transport.");
  const binding = validateTaskChatBinding(taskChatBinding || chatBinding);
  const fixedTarget = getTaskChatReturnTarget(binding);
  const timeout = Number(timeoutMinutes);
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 120) fail(FULL_RELAY_ERRORS.INVALID, "timeoutMinutes must be between 1 and 120.");
  return Object.freeze({
    send: async (input = {}) => {
      const target = input.target;
      if (!isObject(target) || target.binding_id !== fixedTarget.binding_id || target.chat_url !== fixedTarget.chat_url || target.conversation_id !== fixedTarget.conversation_id) {
        fail(FULL_RELAY_ERRORS.IDENTITY_MISMATCH, "ChatGPT transport target does not match the exact task chat binding.");
      }
      boundedText(input.payload, "payload", { required: true, maxBytes: MAX_PAYLOAD_BYTES });
      const result = await callTool({
        name: "chatgpt_reply",
        arguments: {
          prompt: input.payload,
          timeout_minutes: timeout,
          target_url: fixedTarget.chat_url,
          expected_conversation_id: fixedTarget.conversation_id,
        },
      }, {
        task_chat_binding_id: fixedTarget.binding_id,
        conversation_id: fixedTarget.conversation_id,
        relay_request_id: input.relay_request_id,
      });
      if (result?.isError) fail(FULL_RELAY_ERRORS.CHATGPT_DELIVERY_UNKNOWN, "chatgpt_reply MCP call failed.");
      const blocks = Array.isArray(result?.content) ? result.content.filter((item) => item?.type === "text").map((item) => item.text) : [];
      if (blocks.length !== 1) fail(FULL_RELAY_ERRORS.CHATGPT_RESPONSE_INVALID, "chatgpt_reply must return exactly one text response envelope.");
      const toolResult = parseJsonValue(blocks[0], FULL_RELAY_ERRORS.CHATGPT_RESPONSE_INVALID, "chatgpt_reply response");
      // The bundled chatgpt-mcp tool returns a bounded result wrapper whose
      // `response` field contains the actual correlated envelope.  Unwrap
      // only that known shape; do not accept arbitrary wrapper/target data.
      if (isObject(toolResult) && hasOwn(toolResult, "response") && typeof toolResult.response === "string" && !hasOwn(toolResult, "protocol")) {
        const allowedWrapperFields = new Set(["response", "elapsed_seconds", "model", "chat_id", "poll_count", "error"]);
        if (Object.keys(toolResult).some((field) => !allowedWrapperFields.has(field))) fail(FULL_RELAY_ERRORS.CHATGPT_RESPONSE_INVALID, "chatgpt_reply result wrapper contains unknown fields.");
        if (typeof toolResult.error === "string" && toolResult.error.trim()) fail(FULL_RELAY_ERRORS.CHATGPT_DELIVERY_UNKNOWN, "chatgpt_reply reported an error after the send attempt.");
        if (!toolResult.response.trim()) fail(FULL_RELAY_ERRORS.CHATGPT_RESPONSE_INVALID, "chatgpt_reply returned an empty response envelope.");
        if (toolResult.chat_id !== undefined && toolResult.chat_id !== null && toolResult.chat_id !== fixedTarget.conversation_id) fail(FULL_RELAY_ERRORS.IDENTITY_MISMATCH, "chatgpt_reply result conversation does not match the exact task chat binding.");
        return responseEnvelope(toolResult.response);
      }
      return toolResult;
    },
  });
}

export const createExactChatGPTTransport = createBoundChatGPTTransport;

function responseResult(value) {
  if (isObject(value) && value.ambiguous === true) fail(FULL_RELAY_ERRORS.CHATGPT_DELIVERY_UNKNOWN, "ChatGPT transport returned an ambiguous result.");
  if (isObject(value) && hasOwn(value, "envelope") && Object.keys(value).every((key) => key === "envelope" || key === "raw")) return value.envelope;
  if (isObject(value) && hasOwn(value, "response") && Object.keys(value).every((key) => key === "response" || key === "raw")) return value.response;
  return value;
}

function terminalResult(state, extra = {}) {
  return Object.freeze({ status: state.phase, relay_request_id: state.relay_request_id, task_id: state.task_id, ...extra });
}

function isTerminal(phase) {
  return [FULL_RELAY_STATES.COMPLETED, FULL_RELAY_STATES.COMPLETE, FULL_RELAY_STATES.STOPPED, FULL_RELAY_STATES.NEEDS_HUMAN, FULL_RELAY_STATES.DELIVERY_UNKNOWN, FULL_RELAY_STATES.REJECTED].includes(phase);
}

function classifyCodexError(error, sender, returnId) {
  const inspected = returnId && sender?.inspect ? sender.inspect(returnId) : null;
  if (inspected?.status === "DELIVERY_UNKNOWN" || inspected?.status === "IN_FLIGHT") return FULL_RELAY_STATES.DELIVERY_UNKNOWN;
  if (inspected?.status === "REJECTED") return FULL_RELAY_STATES.REJECTED;
  if (error?.code === CODEX_CONTINUATION_ERRORS.DELIVERY_UNKNOWN) return FULL_RELAY_STATES.DELIVERY_UNKNOWN;
  if (error?.code === CODEX_CONTINUATION_ERRORS.IDENTITY_MISMATCH) return FULL_RELAY_STATES.REJECTED;
  if (Object.values(CODEX_RUNTIME_ERRORS).includes(error?.code)) return FULL_RELAY_STATES.REJECTED;
  return FULL_RELAY_STATES.DELIVERY_UNKNOWN;
}

/**
 * Create a bounded one-round Full Relay. All external adapters are injected;
 * this seam never resolves aliases, reads defaults, invokes PATH, or loops.
 */
export function createFullRelayOrchestrator({
  request,
  taskChatBinding,
  chatBinding,
  codexContinuationBinding,
  continuationBinding,
  codexRuntimeBinding,
  runtimeBinding,
  report,
  relay_request_id,
  relayRequestId,
  stateDir,
  conversationStateDir,
  localModel,
  localRelay,
  chatgptTransport,
  chatGPTTransport,
  codexSender,
  continuationSender,
  invokeCodex,
  invoke,
  runtimeProbe,
  probe,
  verifyRuntime,
  now = () => new Date().toISOString(),
  owner_id,
  ownerId,
  chatgptTimeoutMs = 30000,
  localRelayTimeoutMs = 30000,
} = {}) {
  const bindings = validateBindings({ taskChatBinding, chatBinding, codexContinuationBinding, continuationBinding, codexRuntimeBinding, runtimeBinding });
  const relayRequest = request
    ? validateRelayRequest(request, bindings)
    : createRelayRequest({
      taskChatBinding: bindings.chat,
      codexContinuationBinding: bindings.continuation,
      codexRuntimeBinding: bindings.runtime,
      report,
      relay_request_id,
      relayRequestId,
    });
  const store = createRelayStateStore({ stateDir, now });
  const arbitration = createConversationArbitrator({ stateDir: conversationStateDir || stateDir, now, owner_id: owner_id || ownerId });
  let sender = continuationSender || codexSender;
  if (!sender) {
    const codexInvoke = invokeCodex || invoke;
    if (codexInvoke === undefined) fail(FULL_RELAY_ERRORS.CODEX_TRANSPORT_REQUIRED, "A bound Codex process adapter is required.");
    sender = createCodexContinuationSender({
      binding: bindings.continuation,
      runtime: bindings.runtime,
      required_mode: CODEX_CONTINUATION_MODE.QUEUE,
      require_queue: true,
      runtimeProbe: runtimeProbe || probe,
      verifyRuntime,
      invoke: codexInvoke,
    });
  }
  const relayLocalModel = localRelay || localModel;
  resolveAdapter(relayLocalModel, ["decide", "relay", "authorize"], FULL_RELAY_ERRORS.LOCAL_RELAY_REQUIRED);
  const relayChatGPT = chatgptTransport || chatGPTTransport;
  resolveAdapter(relayChatGPT, ["send", "reply", "chatgpt_reply"], FULL_RELAY_ERRORS.CHATGPT_TRANSPORT_REQUIRED);

  let state = store.create(relayRequest);
  let lease = null;

  const save = (patch, options) => {
    try {
      state = store.update(relayRequest.relay_request_id, patch, options);
      return state;
    } catch (error) {
      if (error?.code === FULL_RELAY_ERRORS.STATE_BUSY) state = store.load(relayRequest.relay_request_id) || state;
      throw error;
    }
  };

  const localGate = async (action, payload, payloadHash) => {
    return runLocalRelayGate({ localModel: relayLocalModel, request_id: relayRequest.relay_request_id, payload, payload_sha256: payloadHash, action, timeoutMs: localRelayTimeoutMs });
  };

  const releaseLease = () => {
    if (!lease) return;
    try { arbitration.release(lease); } finally { lease = null; }
  };

  const acquireLease = () => {
    const result = arbitration.acquire({
      conversation_id: bindings.chat.conversation_id,
      task_id: relayRequest.task_id,
      relay_request_id: relayRequest.relay_request_id,
    });
    if (result.status === "ACQUIRED") {
      lease = result.handle;
      return result;
    }
    return result;
  };

  const ensureLeaseForReturn = () => {
    if (lease) return Object.freeze({ status: "ACQUIRED", handle: lease });
    const acquired = acquireLease();
    if (acquired.status === "ACQUIRED") return acquired;
    if (acquired.status === "WAITING_FOR_CONVERSATION_SLOT") return acquired;
    state = save({ phase: FULL_RELAY_STATES.REJECTED, error_code: FULL_RELAY_ERRORS.CONVERSATION_LEASE_INVALID, terminal_reason: "conversation lease is malformed or unprovable" }, { expectedPhase: [FULL_RELAY_STATES.CHATGPT_RESPONSE_RECEIVED, FULL_RELAY_STATES.LOCAL_RETURN_APPROVED] });
    return Object.freeze({ status: "LEASE_INVALID" });
  };

  const sendChatGPT = async () => {
    const payload = relayRequest.report_payload;
    const payloadHash = relayRequest.report_payload_sha256;
    try {
      await localGate(LOCAL_RELAY_ACTIONS.FORWARD_REPORT, payload, payloadHash);
    } catch (error) {
      state = save({ phase: FULL_RELAY_STATES.REJECTED, error_code: error?.code || FULL_RELAY_ERRORS.LOCAL_RELAY_INVALID, terminal_reason: "Local Model RELAY forward gate rejected the exact report" }, { expectedPhase: [FULL_RELAY_STATES.PREPARED, FULL_RELAY_STATES.WAITING_FOR_CONVERSATION_SLOT] });
      return terminalResult(state, { rejected: true });
    }
    const acquired = acquireLease();
    if (acquired.status === "WAITING_FOR_CONVERSATION_SLOT") {
      state = save({ phase: FULL_RELAY_STATES.WAITING_FOR_CONVERSATION_SLOT, lease_holder: acquired.holder }, { expectedPhase: [FULL_RELAY_STATES.PREPARED, FULL_RELAY_STATES.WAITING_FOR_CONVERSATION_SLOT] });
      if (state.phase !== FULL_RELAY_STATES.WAITING_FOR_CONVERSATION_SLOT) return terminalResult(state, { waiting: true });
      return terminalResult(state, { waiting: true, holder: acquired.holder });
    }
    if (acquired.status !== "ACQUIRED") {
      state = save({ phase: FULL_RELAY_STATES.REJECTED, error_code: FULL_RELAY_ERRORS.CONVERSATION_LEASE_INVALID, terminal_reason: "conversation lease is malformed or unprovable" }, { expectedPhase: [FULL_RELAY_STATES.PREPARED, FULL_RELAY_STATES.WAITING_FOR_CONVERSATION_SLOT] });
      return terminalResult(state);
    }
    try {
      state = save({
        phase: FULL_RELAY_STATES.CHATGPT_IN_FLIGHT,
        chatgpt_payload: payload,
        chatgpt_payload_sha256: payloadHash,
        lease_nonce: acquired.handle.record.nonce,
      }, { expectedPhase: [FULL_RELAY_STATES.PREPARED, FULL_RELAY_STATES.WAITING_FOR_CONVERSATION_SLOT] });
    } catch (error) {
      if (error?.code === FULL_RELAY_ERRORS.STATE_BUSY) return terminalResult(state, { waiting: true });
      throw error;
    }
    if (state.phase !== FULL_RELAY_STATES.CHATGPT_IN_FLIGHT) return terminalResult(state, { waiting: true });
    const target = getTaskChatReturnTarget(bindings.chat);
    const input = Object.freeze({
      target,
      chat_url: target.chat_url,
      conversation_id: target.conversation_id,
      mission_id: relayRequest.mission_id,
      task_id: relayRequest.task_id,
      relay_request_id: relayRequest.relay_request_id,
      payload,
      payload_sha256: payloadHash,
    });
    let raw;
    try {
      raw = await callBoundAdapter(relayChatGPT, input, chatgptTimeoutMs, FULL_RELAY_ERRORS.CHATGPT_DELIVERY_UNKNOWN, "ChatGPT");
    } catch (error) {
      state = save({ phase: FULL_RELAY_STATES.DELIVERY_UNKNOWN, error_code: error?.code || FULL_RELAY_ERRORS.CHATGPT_DELIVERY_UNKNOWN, terminal_reason: "ChatGPT delivery result is ambiguous" }, { expectedPhase: FULL_RELAY_STATES.CHATGPT_IN_FLIGHT });
      // Delivery ambiguity is terminal for this request, so the conversation slot is released here.
      releaseLease();
      return terminalResult(state, { delivery_unknown: true });
    }
    let response;
    try {
      response = validateCodexPromptResponse(responseResult(raw), {
        mission_id: relayRequest.mission_id,
        task_id: relayRequest.task_id,
        relay_request_id: relayRequest.relay_request_id,
        report_sha256: relayRequest.report_sha256,
      });
    } catch (error) {
      state = save({ phase: FULL_RELAY_STATES.REJECTED, error_code: error?.code || FULL_RELAY_ERRORS.CHATGPT_RESPONSE_INVALID, terminal_reason: "ChatGPT response envelope was not an exact correlated response" }, { expectedPhase: FULL_RELAY_STATES.CHATGPT_IN_FLIGHT });
      if (state.phase === FULL_RELAY_STATES.REJECTED) releaseLease();
      return terminalResult(state, { rejected: true });
    }
    state = save({
      phase: FULL_RELAY_STATES.CHATGPT_RESPONSE_RECEIVED,
      chatgpt_response: response,
      chatgpt_response_sha256: hashJson(response),
    }, { expectedPhase: FULL_RELAY_STATES.CHATGPT_IN_FLIGHT });
    return null;
  };

  const prepareCodexReturn = async () => {
    if (state.phase !== FULL_RELAY_STATES.CHATGPT_RESPONSE_RECEIVED) return null;
    const response = state.chatgpt_response;
    if (!response || response.decision === RESPONSE_DECISIONS.STOP) {
      state = save({ phase: FULL_RELAY_STATES.STOPPED, terminal_reason: "ChatGPT requested STOP" }, { expectedPhase: FULL_RELAY_STATES.CHATGPT_RESPONSE_RECEIVED });
      if (state.phase === FULL_RELAY_STATES.STOPPED) releaseLease();
      return terminalResult(state);
    }
    if (response.decision === RESPONSE_DECISIONS.COMPLETE) {
      state = save({ phase: FULL_RELAY_STATES.COMPLETE, terminal_reason: "ChatGPT declared the semantic goal complete" }, { expectedPhase: [FULL_RELAY_STATES.CHATGPT_RESPONSE_RECEIVED] });
      if (state.phase === FULL_RELAY_STATES.COMPLETE) releaseLease();
      return terminalResult(state, { semantic_complete: true });
    }
    if (response.decision === RESPONSE_DECISIONS.NEEDS_HUMAN) {
      state = save({ phase: FULL_RELAY_STATES.NEEDS_HUMAN, terminal_reason: "ChatGPT requested human attention" }, { expectedPhase: FULL_RELAY_STATES.CHATGPT_RESPONSE_RECEIVED });
      if (state.phase === FULL_RELAY_STATES.NEEDS_HUMAN) releaseLease();
      return terminalResult(state);
    }
    const prompt = response.prompt;
    const promptHash = digestBytes(prompt);
    try {
      await localGate(LOCAL_RELAY_ACTIONS.RETURN_CODEX_PROMPT, prompt, promptHash);
    } catch (error) {
      state = save({ phase: FULL_RELAY_STATES.REJECTED, error_code: error?.code || FULL_RELAY_ERRORS.LOCAL_RELAY_INVALID, terminal_reason: "Local Model RELAY return gate rejected the exact prompt" }, { expectedPhase: FULL_RELAY_STATES.CHATGPT_RESPONSE_RECEIVED });
      if (state.phase === FULL_RELAY_STATES.REJECTED) releaseLease();
      return terminalResult(state, { rejected: true });
    }
    const returnRequest = createCodexContinuationReturn({
      binding: bindings.continuation,
      prompt,
      response_id: response.prompt_id || state.chatgpt_response_sha256,
    });
    state = save({
      phase: FULL_RELAY_STATES.LOCAL_RETURN_APPROVED,
      codex_prompt_sha256: returnRequest.prompt_sha256,
      codex_return_id: returnRequest.return_id,
    }, { expectedPhase: FULL_RELAY_STATES.CHATGPT_RESPONSE_RECEIVED });
    return null;
  };

  const injectCodex = async () => {
    if (state.phase !== FULL_RELAY_STATES.LOCAL_RETURN_APPROVED) return terminalResult(state);
    const returnRequest = createCodexContinuationReturn({
      binding: bindings.continuation,
      prompt: state.chatgpt_response.prompt,
      response_id: state.chatgpt_response.prompt_id || state.chatgpt_response_sha256,
    });
    try {
      state = save({ phase: FULL_RELAY_STATES.CODEX_IN_FLIGHT }, { expectedPhase: FULL_RELAY_STATES.LOCAL_RETURN_APPROVED });
    } catch (error) {
      if (error?.code === FULL_RELAY_ERRORS.STATE_BUSY) return terminalResult(state, { waiting: true });
      throw error;
    }
    if (state.phase !== FULL_RELAY_STATES.CODEX_IN_FLIGHT) return terminalResult(state, { waiting: true });
    try {
      const result = await sender.send(returnRequest);
      state = save({ phase: FULL_RELAY_STATES.COMPLETED, codex_result: result, terminal_reason: "exact bound Codex thread accepted the queue return" }, { expectedPhase: FULL_RELAY_STATES.CODEX_IN_FLIGHT });
      if (state.phase !== FULL_RELAY_STATES.COMPLETED) return terminalResult(state, { waiting: true });
      releaseLease();
      return terminalResult(state, { thread_id: result.thread_id, mode: result.mode });
    } catch (error) {
      const phase = classifyCodexError(error, sender, returnRequest.return_id);
      const senderRecord = sender?.inspect ? sender.inspect(returnRequest.return_id) : null;
      state = save({ phase, error_code: error?.code || senderRecord?.error_code || FULL_RELAY_ERRORS.CODEX_DELIVERY_UNKNOWN, terminal_reason: phase === FULL_RELAY_STATES.DELIVERY_UNKNOWN ? "Codex injection result is ambiguous" : "Bound Codex runtime rejected the return" }, { expectedPhase: FULL_RELAY_STATES.CODEX_IN_FLIGHT });
      // A wedged conversation slot would block every later round, so ambiguity releases it like rejection does.
      if (state.phase === phase && (phase === FULL_RELAY_STATES.REJECTED || phase === FULL_RELAY_STATES.DELIVERY_UNKNOWN)) releaseLease();
      return terminalResult(state, { delivery_unknown: phase === FULL_RELAY_STATES.DELIVERY_UNKNOWN, rejected: phase === FULL_RELAY_STATES.REJECTED });
    }
  };

  const run = async () => {
    state = store.load(relayRequest.relay_request_id) || store.create(relayRequest);
    compareRequestToState(relayRequest, state);
    if (state.conversation_id !== bindings.chat.conversation_id) fail(FULL_RELAY_ERRORS.IDENTITY_MISMATCH, "Persisted conversation identity does not match the exact task chat binding.");
    if (isTerminal(state.phase)) {
      if (state.phase !== FULL_RELAY_STATES.DELIVERY_UNKNOWN && !lease) {
        const cleanup = acquireLease();
        if (cleanup.status === "ACQUIRED") releaseLease();
      }
      return terminalResult(state, { idempotent: [FULL_RELAY_STATES.COMPLETED, FULL_RELAY_STATES.COMPLETE].includes(state.phase) });
    }
    if (state.phase === FULL_RELAY_STATES.CHATGPT_IN_FLIGHT || state.phase === FULL_RELAY_STATES.CODEX_IN_FLIGHT) {
      return terminalResult(state, { delivery_unknown: true, resumed: true });
    }
    if (state.phase === FULL_RELAY_STATES.PREPARED || state.phase === FULL_RELAY_STATES.WAITING_FOR_CONVERSATION_SLOT) {
      const sent = await sendChatGPT();
      if (sent) return sent;
    }
    if (state.phase === FULL_RELAY_STATES.CHATGPT_RESPONSE_RECEIVED) {
      const returnLease = ensureLeaseForReturn();
      if (returnLease.status === "WAITING_FOR_CONVERSATION_SLOT") return terminalResult(state, { waiting: true, holder: returnLease.holder });
      if (returnLease.status !== "ACQUIRED") return terminalResult(state, { rejected: true });
      const prepared = await prepareCodexReturn();
      if (prepared) return prepared;
    }
    if (state.phase === FULL_RELAY_STATES.LOCAL_RETURN_APPROVED) {
      const returnLease = ensureLeaseForReturn();
      if (returnLease.status === "WAITING_FOR_CONVERSATION_SLOT") return terminalResult(state, { waiting: true, holder: returnLease.holder });
      if (returnLease.status !== "ACQUIRED") return terminalResult(state, { rejected: true });
      return injectCodex();
    }
    return terminalResult(state);
  };

  const inspect = () => cloneFrozen(state);
  return Object.freeze({
    request: relayRequest,
    bindings: cloneFrozen(bindings),
    stateStore: store,
    conversationArbitrator: arbitration,
    run,
    execute: run,
    round: run,
    inspect,
  });
}

export const createFullRelay = createFullRelayOrchestrator;
export const createDevExecFullRelay = createFullRelayOrchestrator;

/** One-shot convenience wrapper; no retry or second round is performed. */
export async function runFullRelayRound(options = {}) {
  const orchestrator = createFullRelayOrchestrator(options);
  return orchestrator.run();
}

export const executeFullRelayRound = runFullRelayRound;
