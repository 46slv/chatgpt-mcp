import crypto from "node:crypto";

import { parseChatGPTTargetUrl } from "./target-registry.mjs";

export const TASK_CHAT_BINDING_PROTOCOL = "devexec.task-chat-binding";
export const TASK_CHAT_BINDING_SCHEMA_VERSION = 1;
export const CODEX_RELAY_REPORT_PROTOCOL = "devexec.codex-relay-report";
export const CODEX_RELAY_REPORT_SCHEMA_VERSION = 1;

export const TASK_CHAT_BINDING_ERRORS = Object.freeze({
  REQUIRED: "TARGET_BINDING_REQUIRED",
  INVALID: "TARGET_BINDING_INVALID",
  MISMATCH: "TARGET_BINDING_MISMATCH",
  TASK_MISMATCH: "TARGET_BINDING_TASK_MISMATCH",
  REBIND_REQUIRED: "TARGET_REBIND_REQUIRED",
  DELIVERY_UNKNOWN: "DELIVERY_UNKNOWN",
});

export const TARGET_BINDING_REQUIRED = TASK_CHAT_BINDING_ERRORS.REQUIRED;
export const TARGET_BINDING_INVALID = TASK_CHAT_BINDING_ERRORS.INVALID;
export const TARGET_BINDING_MISMATCH = TASK_CHAT_BINDING_ERRORS.MISMATCH;
export const TARGET_BINDING_TASK_MISMATCH = TASK_CHAT_BINDING_ERRORS.TASK_MISMATCH;
export const TARGET_REBIND_REQUIRED = TASK_CHAT_BINDING_ERRORS.REBIND_REQUIRED;
export const DELIVERY_UNKNOWN = TASK_CHAT_BINDING_ERRORS.DELIVERY_UNKNOWN;

const BINDING_FIELDS = Object.freeze([
  "protocol",
  "schema_version",
  "mission_id",
  "task_id",
  "chat_url",
  "conversation_id",
  "source",
  "source_alias",
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

export class TaskChatBindingError extends Error {
  constructor(message, code = TASK_CHAT_BINDING_ERRORS.INVALID) {
    super(message);
    this.name = "TaskChatBindingError";
    this.code = code;
  }
}

function fail(code, message, cause = undefined) {
  const error = new TaskChatBindingError(message, code);
  if (cause !== undefined) error.cause = cause;
  throw error;
}

function requiredText(value, label, code = TASK_CHAT_BINDING_ERRORS.REQUIRED) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    fail(code, `${label} must be an exact non-empty string.`);
  }
  return value;
}

function optionalText(value, label) {
  if (value === null) return null;
  return requiredText(value, label, TASK_CHAT_BINDING_ERRORS.INVALID);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

function parseBindingUrl(value) {
  try {
    return parseChatGPTTargetUrl(value);
  } catch (error) {
    fail(TASK_CHAT_BINDING_ERRORS.INVALID, `chat_url is not a canonical ChatGPT conversation URL: ${error.message}`, error);
  }
}

function hashPayload(fields) {
  const payload = {};
  for (const field of HASH_FIELDS) {
    if (field === "protocol") payload[field] = TASK_CHAT_BINDING_PROTOCOL;
    else if (field === "schema_version") payload[field] = TASK_CHAT_BINDING_SCHEMA_VERSION;
    else payload[field] = fields[field];
  }
  return payload;
}

function canonicalHash(fields) {
  const serialized = JSON.stringify(hashPayload(fields));
  const digest = crypto.createHash("sha256").update(serialized, "utf8").digest("hex");
  return `sha256:${digest}`;
}

function bindingFromFields(fields) {
  return Object.freeze({
    protocol: TASK_CHAT_BINDING_PROTOCOL,
    schema_version: TASK_CHAT_BINDING_SCHEMA_VERSION,
    mission_id: fields.mission_id,
    task_id: fields.task_id,
    chat_url: fields.chat_url,
    conversation_id: fields.conversation_id,
    source: fields.source,
    source_alias: fields.source_alias,
    bound_at: fields.bound_at,
    binding_id: canonicalHash(fields),
  });
}

function targetObject(input) {
  if (input.target === undefined || input.target === null) return {};
  if (typeof input.target === "string") return { url: input.target };
  if (!isObject(input.target)) fail(TASK_CHAT_BINDING_ERRORS.INVALID, "target must be an exact URL or target object.");
  return input.target;
}

function normalizeAdmissionInput(input) {
  if (!isObject(input)) fail(TASK_CHAT_BINDING_ERRORS.REQUIRED, "Task chat binding input is required.");

  const target = targetObject(input);
  const chatUrl = firstDefined(input.chat_url, input.url, target.chat_url, target.url);
  if (chatUrl === undefined) fail(TASK_CHAT_BINDING_ERRORS.REQUIRED, "An exact ChatGPT chat_url is required; aliases are not resolved here.");
  const normalizedUrl = parseBindingUrl(chatUrl);

  const conversationCandidate = firstDefined(input.conversation_id, target.conversation_id);
  const conversationId = conversationCandidate === undefined
    ? normalizedUrl.conversation_id
    : requiredText(conversationCandidate, "conversation_id", TASK_CHAT_BINDING_ERRORS.INVALID);
  if (conversationId !== normalizedUrl.conversation_id) {
    fail(TASK_CHAT_BINDING_ERRORS.INVALID, "conversation_id must match chat_url.");
  }

  const sourceCandidate = firstDefined(input.source, target.source);
  const source = sourceCandidate === undefined
    ? "explicit-url"
    : requiredText(sourceCandidate, "source", TASK_CHAT_BINDING_ERRORS.INVALID);

  const sourceAliasCandidate = firstDefined(
    input.source_alias,
    target.source_alias,
    input.alias,
    target.alias,
    input.target_id,
    target.target_id,
  );
  const sourceAlias = sourceAliasCandidate === undefined
    ? null
    : optionalText(sourceAliasCandidate, "source_alias");

  const boundAtCandidate = firstDefined(input.bound_at, input.frozen_at, target.bound_at, target.frozen_at);
  const boundAt = boundAtCandidate === undefined
    ? new Date().toISOString()
    : requiredText(boundAtCandidate, "bound_at", TASK_CHAT_BINDING_ERRORS.INVALID);

  return {
    mission_id: requiredText(input.mission_id, "mission_id"),
    task_id: requiredText(input.task_id, "task_id"),
    chat_url: normalizedUrl.chat_url,
    conversation_id: conversationId,
    source,
    source_alias: sourceAlias,
    bound_at: boundAt,
  };
}

function canonicalizeStoredBinding(value) {
  if (!isObject(value)) fail(TASK_CHAT_BINDING_ERRORS.INVALID, "Task chat binding must be an object.");
  for (const field of BINDING_FIELDS) {
    if (!hasOwn(value, field)) fail(TASK_CHAT_BINDING_ERRORS.INVALID, `Task chat binding field is missing: ${field}.`);
  }
  for (const field of Object.keys(value)) {
    if (!BINDING_FIELDS.includes(field)) fail(TASK_CHAT_BINDING_ERRORS.INVALID, `Unknown task chat binding field: ${field}.`);
  }
  if (value.protocol !== TASK_CHAT_BINDING_PROTOCOL || value.schema_version !== TASK_CHAT_BINDING_SCHEMA_VERSION) {
    fail(TASK_CHAT_BINDING_ERRORS.INVALID, "Unsupported task chat binding protocol or schema_version.");
  }

  const normalizedUrl = parseBindingUrl(value.chat_url);
  const conversationId = requiredText(value.conversation_id, "conversation_id", TASK_CHAT_BINDING_ERRORS.INVALID);
  if (conversationId !== normalizedUrl.conversation_id) fail(TASK_CHAT_BINDING_ERRORS.INVALID, "conversation_id must match chat_url.");

  const fields = {
    mission_id: requiredText(value.mission_id, "mission_id", TASK_CHAT_BINDING_ERRORS.INVALID),
    task_id: requiredText(value.task_id, "task_id", TASK_CHAT_BINDING_ERRORS.INVALID),
    chat_url: normalizedUrl.chat_url,
    conversation_id: conversationId,
    source: requiredText(value.source, "source", TASK_CHAT_BINDING_ERRORS.INVALID),
    source_alias: optionalText(value.source_alias, "source_alias"),
    bound_at: requiredText(value.bound_at, "bound_at", TASK_CHAT_BINDING_ERRORS.INVALID),
  };

  const expectedBindingId = canonicalHash(fields);
  if (value.binding_id !== expectedBindingId) fail(TASK_CHAT_BINDING_ERRORS.INVALID, "binding_id does not match the canonical task chat binding.");
  return { ...fields, binding_id: expectedBindingId };
}

/**
 * Create the parent-owned immutable binding from an already-resolved target.
 * This function accepts a concrete URL (or a target object containing one) and
 * deliberately never resolves an alias, registry default, project config, or
 * legacy environment variable.
 */
export function createTaskChatBinding(input = {}) {
  const fields = normalizeAdmissionInput(input);
  const binding = bindingFromFields(fields);
  if (input.binding_id !== undefined && input.binding_id !== binding.binding_id) {
    fail(TASK_CHAT_BINDING_ERRORS.INVALID, "Supplied binding_id does not match the parent-owned binding.");
  }
  return binding;
}

export const bindTaskChatTarget = createTaskChatBinding;
export const createTaskBoundChatBinding = createTaskChatBinding;

/** Validate and return a canonical immutable copy of a stored binding. */
export function validateTaskChatBinding(value) {
  if (value === null || value === undefined) fail(TASK_CHAT_BINDING_ERRORS.REQUIRED, "Task chat binding is required.");
  const canonical = canonicalizeStoredBinding(value);
  return Object.freeze({
    protocol: TASK_CHAT_BINDING_PROTOCOL,
    schema_version: TASK_CHAT_BINDING_SCHEMA_VERSION,
    ...canonical,
  });
}

/** Return the only target shape that an autonomous relay may send to. */
export function getTaskChatReturnTarget(binding) {
  const validated = validateTaskChatBinding(binding);
  return Object.freeze({
    binding_id: validated.binding_id,
    chat_url: validated.chat_url,
    conversation_id: validated.conversation_id,
  });
}

export const taskChatReturnTarget = getTaskChatReturnTarget;

function validateReturnTarget(reportTarget, binding) {
  if (!isObject(reportTarget)) fail(TASK_CHAT_BINDING_ERRORS.REQUIRED, "Relay report return_target is required.");
  for (const field of ["binding_id", "chat_url", "conversation_id"]) {
    if (!hasOwn(reportTarget, field)) fail(TASK_CHAT_BINDING_ERRORS.REQUIRED, `Relay report return_target field is missing: ${field}.`);
  }

  let normalizedUrl;
  try {
    normalizedUrl = parseChatGPTTargetUrl(reportTarget.chat_url);
  } catch (error) {
    fail(TASK_CHAT_BINDING_ERRORS.INVALID, `Relay report return_target chat_url is invalid: ${error.message}`, error);
  }

  if (
    reportTarget.binding_id !== binding.binding_id ||
    normalizedUrl.chat_url !== binding.chat_url ||
    normalizedUrl.conversation_id !== binding.conversation_id ||
    reportTarget.conversation_id !== binding.conversation_id
  ) {
    fail(TASK_CHAT_BINDING_ERRORS.MISMATCH, "Relay report return_target does not match the stored task chat binding.");
  }
  return getTaskChatReturnTarget(binding);
}

/**
 * Verify a Codex relay report against parent state. The returned report
 * reconstructs return_target from the validated parent binding, so model
 * output never becomes routing authority.
 */
export function validateTaskChatRelayReport(report, binding) {
  const validatedBinding = validateTaskChatBinding(binding);
  if (!isObject(report)) fail(TASK_CHAT_BINDING_ERRORS.INVALID, "Codex relay report must be an object.");
  if (report.protocol !== CODEX_RELAY_REPORT_PROTOCOL || report.schema_version !== CODEX_RELAY_REPORT_SCHEMA_VERSION) {
    fail(TASK_CHAT_BINDING_ERRORS.INVALID, "Unsupported Codex relay report protocol or schema_version.");
  }
  if (report.task_id !== validatedBinding.task_id) {
    fail(TASK_CHAT_BINDING_ERRORS.TASK_MISMATCH, "Codex relay report task_id does not match the stored task chat binding.");
  }
  if (hasOwn(report, "mission_id") && report.mission_id !== validatedBinding.mission_id) {
    fail(TASK_CHAT_BINDING_ERRORS.TASK_MISMATCH, "Codex relay report mission_id does not match the stored task chat binding.");
  }

  const returnTarget = validateReturnTarget(report.return_target, validatedBinding);
  return Object.freeze({
    ...report,
    task_id: validatedBinding.task_id,
    return_target: returnTarget,
  });
}

export const validateRelayReport = validateTaskChatRelayReport;
export const validateTaskChatBindingReport = validateTaskChatRelayReport;

/** Build a report with a parent-reconstructed return target for tests/adapters. */
export function createTaskChatRelayReport({ binding, completion = "", situation = "", ...fields } = {}) {
  const validatedBinding = validateTaskChatBinding(binding);
  return Object.freeze({
    ...fields,
    protocol: CODEX_RELAY_REPORT_PROTOCOL,
    schema_version: CODEX_RELAY_REPORT_SCHEMA_VERSION,
    task_id: validatedBinding.task_id,
    completion,
    situation,
    return_target: getTaskChatReturnTarget(validatedBinding),
  });
}

export const buildTaskChatRelayReport = createTaskChatRelayReport;

/** Expose the canonical hash payload for parent-owned persistence/auditing. */
export function taskChatBindingHashPayload(binding) {
  const validated = validateTaskChatBinding(binding);
  return Object.freeze({ ...hashPayload(validated) });
}

export function taskChatBindingId(binding) {
  return validateTaskChatBinding(binding).binding_id;
}
