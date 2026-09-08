import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  DevExecMissionStore,
  MissionCoreError,
  OPERATOR_EVENT_PROTOCOL,
} from "./devexec-mission-store.mjs";
import { DevExecMissionStore as CoreMissionStore } from "./devexec-mission-store-core.mjs";

export const MISSION_REQUEST_PROTOCOL = "devexec.mission-request";
export const MISSION_COMMAND_PROTOCOL = "devexec.mission-command";
export const MISSION_CONTROL_PROJECTION_PROTOCOL = "devexec.mission-control-projection";
export const MISSION_ARTIFACT_PROTOCOL = "devexec.mission-artifact";
export const MISSION_CONTROL_SCHEMA_VERSION = 1;

const REQUEST_KEYS = [
  "protocol", "schema_version", "event_id", "request_id", "idempotency_key", "occurred_at",
  "source", "actor", "intent", "requested_authority", "goal", "correlation_id",
];
const COMMAND_KEYS = [
  "protocol", "schema_version", "event_id", "request_id", "idempotency_key", "occurred_at",
  "source", "actor", "mission_id", "expected_revision", "action", "data", "correlation_id",
];
const SOURCE_KEYS = ["type", "adapter", "binding_id"];
const ACTOR_KEYS = ["binding_id", "axis", "role"];
const GOAL_KEYS = ["goal_id", "summary", "acceptance_refs", "protected_constraints"];
const ARTIFACT_REF_KEYS = ["sha256", "location", "scope", "kind"];
const MODEL_KEYS = ["configured_model", "selected_model", "loaded_model"];
const START_EPISODE_KEYS = [
  "episode_id", "axis", "role", "input_ref", "source_revision", "source_snapshot_hash",
  "session_id", "context_fingerprint", "parent_receipt_ref", "history_forwarded", "execution_authority", "runtime_class", "model",
];
const COMPLETE_EPISODE_KEYS = ["episode_id", "status", "output_ref", "evidence_refs", "summary"];
const ADVANCE_GOAL_KEYS = ["decision", "verification_episode_id", "evidence_refs", "summary"];
const COMPLETE_KEYS = ["summary", "changed_surface", "evidence_refs", "remaining_limits", "verification_episode_id"];
const REASON_KEYS = ["reason"];
const CANCEL_KEYS = ["reason", "evidence_refs"];
const FOLLOWUP_KEYS = ["payload_ref", "summary"];
const EMPTY_KEYS = [];

const AXIS_ROLES = Object.freeze({
  DETERMINISTIC: new Set(["OPERATOR_INGRESS", "CONTROL_REDUCER"]),
  TASK_EXECUTION: new Set(["WORKER", "TASK_PLANNER"]),
  GOAL_CONTROL: new Set(["GOAL_CONTROLLER", "TECHNICAL_VERIFIER"]),
  MISSION_GOVERNANCE: new Set(["MISSION_GOVERNOR"]),
});
const LIFECYCLE_ACTIONS = new Set(["START", "RESUME", "PAUSE", "CANCEL", "COMPLETE"]);
const COMMAND_ACTIONS = new Set([
  ...LIFECYCLE_ACTIONS,
  "FOLLOWUP", "START_EPISODE", "COMPLETE_EPISODE", "ADVANCE_GOAL",
]);
const TERMINAL_MISSION_STATES = new Set(["COMPLETE", "CANCELLED", "FAILED", "BLOCKED", "NEEDS_HUMAN"]);
const EPISODE_STATUSES = new Set(["PASS", "FAIL", "BLOCKED", "NEEDS_CONTEXT", "CANCELLED"]);
const LOGICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_REF = /^sha256:([a-f0-9]{64})$/;
const MAX_PAYLOAD_BYTES = 128 * 1024;
const MAX_EVENTS = 16384;

export class MissionControllerError extends Error {
  constructor(code, message, { status = "BLOCKED", retryable = false } = {}) {
    super(message);
    this.name = "MissionControllerError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  if (!isObject(value)) throw new MissionControllerError("INVALID_MISSION_INPUT", `${label} must be an object`, { status: "REJECTED" });
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || expected.some((key, index) => key !== actual[index])) {
    throw new MissionControllerError("INVALID_MISSION_INPUT", `${label} has unknown or missing keys`, { status: "REJECTED" });
  }
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function digest(value) {
  return crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : canonical(value)).digest("hex");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateId(value, label) {
  if (typeof value !== "string" || !LOGICAL_ID.test(value) || value.includes("..") || /[\\/]/.test(value)) {
    throw new MissionControllerError("INVALID_MISSION_IDENTITY", `${label} is invalid`, { status: "REJECTED" });
  }
  return value;
}

function validateString(value, label, max = 512, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && !value.trim()) || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) {
    throw new MissionControllerError("INVALID_MISSION_INPUT", `${label} is invalid`, { status: "REJECTED" });
  }
  return value;
}

function validateTimestamp(value, label = "occurred_at") {
  if (typeof value !== "string" || value.length < 20 || value.length > 40 || !Number.isFinite(Date.parse(value))) {
    throw new MissionControllerError("INVALID_MISSION_TIMESTAMP", `${label} is invalid`, { status: "REJECTED" });
  }
  return value;
}

function validateStrings(value, label, maxItems = 128, maxChars = 512) {
  if (!Array.isArray(value) || value.length > maxItems) throw new MissionControllerError("INVALID_MISSION_INPUT", `${label} is invalid`, { status: "REJECTED" });
  value.forEach((item) => validateString(item, label, maxChars));
  return [...value];
}

function validateSource(source) {
  exactKeys(source, SOURCE_KEYS, "source");
  if (source.type !== "operator") throw new MissionControllerError("INVALID_MISSION_SOURCE", "source.type must be operator", { status: "REJECTED" });
  validateString(source.adapter, "source.adapter", 96);
  if (!SHA256_REF.test(source.binding_id)) throw new MissionControllerError("INVALID_MISSION_SOURCE", "source.binding_id is invalid", { status: "REJECTED" });
  return clone(source);
}

function validateActor(actor, { source = null } = {}) {
  exactKeys(actor, ACTOR_KEYS, "actor");
  if (!SHA256_REF.test(actor.binding_id)) throw new MissionControllerError("INVALID_ACTOR", "actor.binding_id is invalid", { status: "REJECTED" });
  if (source && actor.binding_id !== source.binding_id) throw new MissionControllerError("ACTOR_SOURCE_MISMATCH", "actor and source binding differ", { status: "REJECTED" });
  if (!AXIS_ROLES[actor.axis]?.has(actor.role)) throw new MissionControllerError("INVALID_AXIS_ROLE", "actor axis/role pairing is invalid", { status: "REJECTED" });
  return clone(actor);
}

function validateGoal(goal) {
  exactKeys(goal, GOAL_KEYS, "goal");
  validateId(goal.goal_id, "goal.goal_id");
  validateString(goal.summary, "goal.summary", 4096);
  return {
    goal_id: goal.goal_id,
    summary: goal.summary,
    acceptance_refs: validateStrings(goal.acceptance_refs, "goal.acceptance_refs"),
    protected_constraints: validateStrings(goal.protected_constraints, "goal.protected_constraints"),
  };
}

function validateArtifactRef(ref, label, { missionId = null, kind = null } = {}) {
  exactKeys(ref, ARTIFACT_REF_KEYS, label);
  const match = typeof ref.sha256 === "string" ? SHA256_REF.exec(ref.sha256) : null;
  if (!match) throw new MissionControllerError("INVALID_ARTIFACT_REF", `${label}.sha256 is invalid`, { status: "REJECTED" });
  validateString(ref.location, `${label}.location`, 512);
  if (ref.scope !== "MISSION") throw new MissionControllerError("ARTIFACT_SCOPE_MISMATCH", `${label}.scope must be MISSION`, { status: "REJECTED" });
  validateString(ref.kind, `${label}.kind`, 64);
  if (kind !== null && ref.kind !== kind) throw new MissionControllerError("ARTIFACT_KIND_MISMATCH", `${label}.kind must be ${kind}`, { status: "REJECTED" });
  if (missionId !== null && !ref.location.startsWith(`mission-control/artifacts/${missionId}/`)) {
    throw new MissionControllerError("ARTIFACT_SCOPE_MISMATCH", `${label} is outside the exact Mission scope`, { status: "REJECTED" });
  }
  if (!ref.location.endsWith(`/${match[1]}.json`)) throw new MissionControllerError("ARTIFACT_IDENTITY_MISMATCH", `${label} path/digest mismatch`, { status: "REJECTED" });
  return clone(ref);
}

function validateCommon(input, protocol, keys) {
  exactKeys(input, keys, protocol);
  if (input.protocol !== protocol || input.schema_version !== MISSION_CONTROL_SCHEMA_VERSION) {
    throw new MissionControllerError("UNSUPPORTED_MISSION_SCHEMA", `unsupported ${protocol} schema`, { status: "REJECTED" });
  }
  validateId(input.event_id, "event_id");
  validateId(input.request_id, "request_id");
  validateString(input.idempotency_key, "idempotency_key", 256);
  validateTimestamp(input.occurred_at);
  const source = validateSource(input.source);
  const actor = validateActor(input.actor, { source });
  validateId(input.correlation_id, "correlation_id");
  return { source, actor };
}

export function validateMissionRequest(input) {
  const { source, actor } = validateCommon(input, MISSION_REQUEST_PROTOCOL, REQUEST_KEYS);
  if (actor.axis !== "DETERMINISTIC" || actor.role !== "OPERATOR_INGRESS") {
    throw new MissionControllerError("REQUESTER_ROLE_FORBIDDEN", "Mission creation requires deterministic operator ingress", { status: "REJECTED" });
  }
  if (!new Set(["TASK", "CONSULTATION"]).has(input.intent)) throw new MissionControllerError("UNSUPPORTED_INTENT", "intent is invalid", { status: "REJECTED" });
  if (!new Set(["READ_ONLY", "BOUNDED_WRITE"]).has(input.requested_authority)) throw new MissionControllerError("UNSUPPORTED_AUTHORITY_CLASS", "requested_authority is invalid", { status: "REJECTED" });
  if (input.intent === "CONSULTATION" && input.requested_authority !== "READ_ONLY") {
    throw new MissionControllerError("CONSULTATION_AUTHORITY_CONTRADICTION", "CONSULTATION must remain READ_ONLY");
  }
  return {
    protocol: input.protocol,
    schema_version: input.schema_version,
    event_id: input.event_id,
    request_id: input.request_id,
    idempotency_key: input.idempotency_key,
    occurred_at: input.occurred_at,
    source,
    actor,
    intent: input.intent,
    requested_authority: input.requested_authority,
    goal: validateGoal(input.goal),
    correlation_id: input.correlation_id,
  };
}

function validateCommandData(action, data, missionId) {
  const keys = action === "START_EPISODE" ? START_EPISODE_KEYS
    : action === "COMPLETE_EPISODE" ? COMPLETE_EPISODE_KEYS
      : action === "ADVANCE_GOAL" ? ADVANCE_GOAL_KEYS
        : action === "COMPLETE" ? COMPLETE_KEYS
          : action === "CANCEL" ? CANCEL_KEYS
            : action === "FOLLOWUP" ? FOLLOWUP_KEYS
            : new Set(["START", "RESUME", "PAUSE"]).has(action) ? REASON_KEYS : EMPTY_KEYS;
  exactKeys(data, keys, `${action}.data`);
  if (new Set(["START", "RESUME", "PAUSE"]).has(action)) return { reason: validateString(data.reason, "reason", 1024) };
  if (action === "CANCEL") return { reason: validateString(data.reason, "reason", 4096), evidence_refs: validateStrings(data.evidence_refs, "evidence_refs") };
  if (action === "FOLLOWUP") return {
    payload_ref: validateArtifactRef(data.payload_ref, "payload_ref", { missionId, kind: "FOLLOWUP_INPUT" }),
    summary: validateString(data.summary, "summary", 4096),
  };
  if (action === "START_EPISODE") {
    validateId(data.episode_id, "episode_id");
    if (!AXIS_ROLES[data.axis]?.has(data.role) || data.axis === "MISSION_GOVERNANCE" || data.axis === "DETERMINISTIC") {
      throw new MissionControllerError("INVALID_EPISODE_AXIS_ROLE", "Episode axis/role is not an executable role", { status: "REJECTED" });
    }
    if (!Number.isInteger(data.source_revision) || data.source_revision < 1) throw new MissionControllerError("INVALID_SOURCE_REVISION", "source_revision is invalid", { status: "REJECTED" });
    if (!SHA256_REF.test(data.source_snapshot_hash)) throw new MissionControllerError("INVALID_SOURCE_HASH", "source_snapshot_hash is invalid", { status: "REJECTED" });
    validateId(data.session_id, "session_id");
    if (!SHA256_REF.test(data.context_fingerprint)) throw new MissionControllerError("INVALID_CONTEXT_FINGERPRINT", "context_fingerprint is invalid", { status: "REJECTED" });
    if (data.history_forwarded !== false) throw new MissionControllerError("EPISODE_HISTORY_FORWARDING_FORBIDDEN", "fresh Episode history_forwarded must be false");
    validateString(data.runtime_class, "runtime_class", 64);
    if (!new Set(["READ_ONLY", "BOUNDED_WRITE"]).has(data.execution_authority)) throw new MissionControllerError("UNSUPPORTED_AUTHORITY_CLASS", "execution_authority is invalid", { status: "REJECTED" });
    exactKeys(data.model, MODEL_KEYS, "model");
    for (const key of MODEL_KEYS) {
      if (data.model[key] !== null) validateString(data.model[key], `model.${key}`, 128);
    }
    return {
      episode_id: data.episode_id,
      axis: data.axis,
      role: data.role,
      input_ref: validateArtifactRef(data.input_ref, "input_ref", { missionId, kind: "EPISODE_INPUT" }),
      source_revision: data.source_revision,
      source_snapshot_hash: data.source_snapshot_hash,
      session_id: data.session_id,
      context_fingerprint: data.context_fingerprint,
      parent_receipt_ref: validateArtifactRef(data.parent_receipt_ref, "parent_receipt_ref", { missionId, kind: "FRESH_CONTEXT_RECEIPT" }),
      history_forwarded: false,
      execution_authority: data.execution_authority,
      runtime_class: data.runtime_class,
      model: clone(data.model),
    };
  }
  if (action === "COMPLETE_EPISODE") {
    validateId(data.episode_id, "episode_id");
    if (!EPISODE_STATUSES.has(data.status)) throw new MissionControllerError("INVALID_EPISODE_STATUS", "Episode status is invalid", { status: "REJECTED" });
    return {
      episode_id: data.episode_id,
      status: data.status,
      output_ref: validateArtifactRef(data.output_ref, "output_ref", { missionId, kind: "EPISODE_OUTPUT" }),
      evidence_refs: validateStrings(data.evidence_refs, "evidence_refs"),
      summary: validateString(data.summary, "summary", 4096),
    };
  }
  if (action === "ADVANCE_GOAL") {
    if (!new Set(["ADVANCE", "COMPLETE"]).has(data.decision)) throw new MissionControllerError("INVALID_GOAL_DECISION", "Goal decision is invalid", { status: "REJECTED" });
    validateId(data.verification_episode_id, "verification_episode_id");
    return {
      decision: data.decision,
      verification_episode_id: data.verification_episode_id,
      evidence_refs: validateStrings(data.evidence_refs, "evidence_refs"),
      summary: validateString(data.summary, "summary", 4096),
    };
  }
  if (action === "COMPLETE") {
    validateId(data.verification_episode_id, "verification_episode_id");
    return {
      summary: validateString(data.summary, "summary", 16000),
      changed_surface: validateStrings(data.changed_surface, "changed_surface"),
      evidence_refs: validateStrings(data.evidence_refs, "evidence_refs"),
      remaining_limits: validateStrings(data.remaining_limits, "remaining_limits"),
      verification_episode_id: data.verification_episode_id,
    };
  }
  return {};
}

export function validateMissionCommand(input) {
  const { source, actor } = validateCommon(input, MISSION_COMMAND_PROTOCOL, COMMAND_KEYS);
  validateId(input.mission_id, "mission_id");
  if (!Number.isInteger(input.expected_revision) || input.expected_revision < 1) throw new MissionControllerError("INVALID_EXPECTED_REVISION", "expected_revision is invalid", { status: "REJECTED" });
  if (!COMMAND_ACTIONS.has(input.action)) throw new MissionControllerError("UNSUPPORTED_MISSION_ACTION", "action is invalid", { status: "REJECTED" });
  return {
    protocol: input.protocol,
    schema_version: input.schema_version,
    event_id: input.event_id,
    request_id: input.request_id,
    idempotency_key: input.idempotency_key,
    occurred_at: input.occurred_at,
    source,
    actor,
    mission_id: input.mission_id,
    expected_revision: input.expected_revision,
    action: input.action,
    data: validateCommandData(input.action, input.data, input.mission_id),
    correlation_id: input.correlation_id,
  };
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink?.() || stat.isReparsePoint?.()) throw new MissionControllerError("UNSAFE_MISSION_STATE_PATH", "Mission control directory is unsafe");
}

function ensureRegularFile(file, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink?.() || stat.isReparsePoint?.() || (Number.isInteger(stat.nlink) && stat.nlink > 1)) {
    throw new MissionControllerError("UNSAFE_MISSION_STATE_PATH", `${label} is not a private regular file`);
  }
  if (stat.size > MAX_PAYLOAD_BYTES) throw new MissionControllerError("MISSION_PAYLOAD_TOO_LARGE", `${label} exceeds the byte bound`);
  return stat;
}

function writeExclusive(file, bytes) {
  ensureDirectory(path.dirname(file));
  let fd;
  try {
    fd = fs.openSync(file, "wx", 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = fs.readFileSync(file);
    if (!existing.equals(bytes)) throw new MissionControllerError("IMMUTABLE_PAYLOAD_CONFLICT", "content-addressed payload conflicts with existing bytes");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function projectionHash(projection) {
  const value = clone(projection);
  value.snapshot_hash = null;
  // These fields describe the current read observation, not the applied
  // lifecycle semantics. Excluding them keeps an Episode input binding stable
  // when a newer canonical Event updates the source snapshot projection.
  delete value.source_mission_snapshot_hash;
  delete value.source_last_journal_seq;
  delete value.result_id;
  delete value.result_status;
  delete value.deferred_commands;
  return `sha256:${digest(value)}`;
}

function authorityClassFor(mission) {
  return mission.intent === "CONSULTATION" ? "READ_ONLY" : mission.authority_ceiling;
}

function requireRole(command) {
  const { actor, action } = command;
  if (LIFECYCLE_ACTIONS.has(action) || action === "START_EPISODE") {
    if (actor.axis !== "MISSION_GOVERNANCE" || actor.role !== "MISSION_GOVERNOR") {
      throw new MissionControllerError("MISSION_GOVERNANCE_REQUIRED", `${action} requires MISSION_GOVERNOR`);
    }
  } else if (action === "ADVANCE_GOAL") {
    if (actor.axis !== "GOAL_CONTROL" || actor.role !== "GOAL_CONTROLLER") throw new MissionControllerError("GOAL_CONTROL_REQUIRED", "ADVANCE_GOAL requires GOAL_CONTROLLER");
  } else if (action === "FOLLOWUP") {
    if (actor.axis !== "DETERMINISTIC" || actor.role !== "OPERATOR_INGRESS") throw new MissionControllerError("OPERATOR_INGRESS_REQUIRED", "FOLLOWUP requires deterministic operator ingress");
  }
}

function invalidateGoal(projection) {
  if (projection.goal.status !== "OPEN") projection.goal.revision += 1;
  projection.goal.status = "OPEN";
  projection.goal.last_verification_episode_id = null;
  projection.goal.evidence_refs = [];
}

function requireCurrentVerifier(projection, episodeId) {
  const verifier = projection.episodes.find((item) => item.episode_id === episodeId);
  if (!verifier || verifier.axis !== "GOAL_CONTROL" || verifier.role !== "TECHNICAL_VERIFIER" || verifier.status !== "PASS") {
    throw new MissionControllerError("INDEPENDENT_VERIFICATION_REQUIRED", "completion requires a PASS Technical Verifier Episode");
  }
  if (projection.episodes.at(-1)?.episode_id !== episodeId || projection.context_events.some((event) => event.applied_revision > verifier.source_revision)) {
    throw new MissionControllerError("STALE_VERIFICATION", "verification must follow the latest work and scope change");
  }
  return verifier;
}

function commandSemanticApply(projection, command, { reducing = false } = {}) {
  const next = clone(projection);
  const action = command.action;
  const active = next.active_episode;
  requireRole(command);
  if (TERMINAL_MISSION_STATES.has(next.status)) throw new MissionControllerError("MISSION_TERMINAL", "Mission is already terminal");

  if (action === "START") {
    if (next.status !== "CREATED") throw new MissionControllerError("INVALID_MISSION_TRANSITION", `cannot START from ${next.status}`);
    next.status = "RUNNING";
  } else if (action === "RESUME") {
    if (next.status !== "PAUSED") throw new MissionControllerError("INVALID_MISSION_TRANSITION", `cannot RESUME from ${next.status}`);
    next.status = "RUNNING";
  } else if (action === "PAUSE") {
    if (next.status !== "RUNNING") throw new MissionControllerError("INVALID_MISSION_TRANSITION", `cannot PAUSE from ${next.status}`);
    if (active) throw new MissionControllerError("SAFE_BOUNDARY_PENDING", "pause waits for the active Episode boundary", { status: "DEFERRED", retryable: true });
    next.status = "PAUSED";
  } else if (action === "CANCEL") {
    if (!new Set(["CREATED", "RUNNING", "PAUSED"]).has(next.status)) throw new MissionControllerError("INVALID_MISSION_TRANSITION", `cannot CANCEL from ${next.status}`);
    if (active) throw new MissionControllerError("SAFE_BOUNDARY_PENDING", "cancel waits for the active Episode boundary", { status: "DEFERRED", retryable: true });
    next.status = "CANCELLED";
  } else if (action === "FOLLOWUP") {
    if (!new Set(["CREATED", "RUNNING", "PAUSED"]).has(next.status)) throw new MissionControllerError("INVALID_MISSION_TRANSITION", `cannot FOLLOWUP from ${next.status}`);
    if (active) throw new MissionControllerError("SAFE_BOUNDARY_PENDING", "follow-up waits for the active Episode boundary", { status: "DEFERRED", retryable: true });
    next.context_events.push({ event_id: command.event_id, payload_ref: command.data.payload_ref, summary: command.data.summary, applied_at: command.occurred_at, applied_revision: next.revision + 1 });
    invalidateGoal(next);
  } else if (action === "START_EPISODE") {
    if (next.status !== "RUNNING") throw new MissionControllerError("MISSION_NOT_RUNNING", "Episode requires RUNNING Mission");
    if (active) throw new MissionControllerError("EPISODE_ALREADY_ACTIVE", "an Episode is already active");
    if (next.episodes.some((episode) => episode.episode_id === command.data.episode_id)) throw new MissionControllerError("EPISODE_ID_REPLAY", "episode_id was already used");
    if (command.data.source_revision !== next.revision || command.data.source_snapshot_hash !== next.snapshot_hash) {
      throw new MissionControllerError("STALE_EPISODE_INPUT", "Episode input does not bind the current Mission projection");
    }
    if (next.episodes.some((episode) => episode.session_id === command.data.session_id || episode.context_fingerprint === command.data.context_fingerprint)) {
      throw new MissionControllerError("EPISODE_CONTEXT_REUSE", "fresh Episode identity was reused");
    }
    const episode = {
      episode_id: command.data.episode_id,
      axis: command.data.axis,
      role: command.data.role,
      status: "RUNNING",
      started_at: command.occurred_at,
      completed_at: null,
      input_ref: command.data.input_ref,
      output_ref: null,
      source_revision: command.data.source_revision,
      source_snapshot_hash: command.data.source_snapshot_hash,
      session_id: command.data.session_id,
      context_fingerprint: command.data.context_fingerprint,
      parent_receipt_ref: command.data.parent_receipt_ref,
      history_forwarded: false,
      execution_authority: command.data.execution_authority,
      freshness: "PARENT_VERIFIED",
      runtime_class: command.data.runtime_class,
      model: command.data.model,
      evidence_refs: [],
      summary: null,
    };
    next.episodes.push(episode);
    next.active_episode = clone(episode);
    invalidateGoal(next);
  } else if (action === "COMPLETE_EPISODE") {
    if (!active || active.episode_id !== command.data.episode_id) throw new MissionControllerError("EPISODE_BINDING_MISMATCH", "completion does not bind the active Episode");
    if (command.actor.axis !== active.axis || command.actor.role !== active.role) throw new MissionControllerError("EPISODE_ROLE_MISMATCH", "only the assigned Episode role can submit its outcome");
    const episode = next.episodes.find((item) => item.episode_id === active.episode_id);
    episode.status = command.data.status;
    episode.completed_at = command.occurred_at;
    episode.output_ref = command.data.output_ref;
    episode.evidence_refs = command.data.evidence_refs;
    episode.summary = command.data.summary;
    next.active_episode = null;
  } else if (action === "ADVANCE_GOAL") {
    if (active) throw new MissionControllerError("EPISODE_ACTIVE", "Goal transition requires an Episode boundary");
    const verifier = requireCurrentVerifier(next, command.data.verification_episode_id);
    const priorExecution = [...next.episodes].reverse().find((item) => item.axis === "TASK_EXECUTION");
    if (priorExecution && (priorExecution.session_id === verifier.session_id || priorExecution.context_fingerprint === verifier.context_fingerprint)) {
      throw new MissionControllerError("VERIFIER_NOT_INDEPENDENT", "Verifier reused execution context");
    }
    next.goal.revision += 1;
    next.goal.status = command.data.decision === "COMPLETE" ? "COMPLETE" : "ADVANCED";
    next.goal.last_verification_episode_id = verifier.episode_id;
    next.goal.evidence_refs = command.data.evidence_refs;
    next.goal.summary = command.data.summary;
  } else if (action === "COMPLETE") {
    if (active) throw new MissionControllerError("SAFE_BOUNDARY_PENDING", "completion waits for the active Episode boundary", { status: "DEFERRED", retryable: true });
    if (next.goal.status !== "COMPLETE" || next.goal.last_verification_episode_id !== command.data.verification_episode_id) {
      throw new MissionControllerError("GOAL_NOT_INDEPENDENTLY_COMPLETE", "Mission completion requires the verified COMPLETE Goal transition");
    }
    requireCurrentVerifier(next, command.data.verification_episode_id);
    next.status = "COMPLETE";
  }

  next.revision += 1;
  next.last_event_id = command.event_id;
  next.last_event_at = command.occurred_at;
  next.snapshot_hash = projectionHash(next);
  if (!reducing) return next;
  return next;
}

export class DevExecMissionController {
  constructor({ stateDir, now = () => new Date(), validateAuthority, verifyFreshContext, store = null } = {}) {
    if (typeof stateDir !== "string" || !stateDir.trim()) throw new MissionControllerError("STATE_DIR_REQUIRED", "stateDir is required");
    this.stateDir = path.resolve(stateDir);
    this.store = store || new DevExecMissionStore({ stateDir: this.stateDir, now });
    this.validateAuthority = validateAuthority;
    this.verifyFreshContext = verifyFreshContext;
    this.payloadRoot = path.join(this.stateDir, "mission-control", "payloads");
    this.artifactRoot = path.join(this.stateDir, "mission-control", "artifacts");
    ensureDirectory(this.payloadRoot);
    ensureDirectory(this.artifactRoot);
  }

  checkAuthority({ action, mission = null, actor, requestedAuthority }) {
    if (typeof this.validateAuthority !== "function") throw new MissionControllerError("AUTHORITY_VALIDATOR_REQUIRED", "Mission mutation requires an injected authority validator");
    let result;
    try { result = this.validateAuthority({ action, mission: mission ? clone(mission) : null, actor: clone(actor), requested_authority: requestedAuthority }); }
    catch (error) { throw new MissionControllerError("AUTHORITY_VALIDATION_FAILED", String(error?.message || error)); }
    if (!isObject(result) || result.allowed !== true || typeof result.authority_ref !== "string" || !result.authority_ref.trim()) {
      throw new MissionControllerError("AUTHORITY_DENIED", "authority validator denied the Mission action");
    }
    return clone(result);
  }

  payloadRefFor(value) {
    const bytes = Buffer.from(`${canonical(value)}\n`, "utf8");
    if (bytes.length > MAX_PAYLOAD_BYTES) throw new MissionControllerError("MISSION_PAYLOAD_TOO_LARGE", "Mission control payload exceeds byte bound", { status: "REJECTED" });
    const hash = digest(bytes);
    const location = `mission-control/payloads/${hash}.json`;
    writeExclusive(path.join(this.stateDir, ...location.split("/")), bytes);
    return { sha256: `sha256:${hash}`, location };
  }

  readPayload(ref) {
    const match = typeof ref?.sha256 === "string" ? SHA256_REF.exec(ref.sha256) : null;
    if (!match || ref.location !== `mission-control/payloads/${match[1]}.json`) throw new MissionControllerError("CORRUPT_CONTROL_PAYLOAD", "Event payload reference is outside the Mission control payload store");
    const file = path.join(this.stateDir, ...ref.location.split("/"));
    try { ensureRegularFile(file, "Mission control payload"); } catch (error) { if (error?.code === "ENOENT") throw new MissionControllerError("MISSING_CONTROL_PAYLOAD", "Mission control payload is missing"); throw error; }
    const bytes = fs.readFileSync(file);
    if (digest(bytes) !== match[1]) throw new MissionControllerError("CORRUPT_CONTROL_PAYLOAD", "Mission control payload digest mismatch");
    try { return JSON.parse(bytes.toString("utf8")); }
    catch { throw new MissionControllerError("CORRUPT_CONTROL_PAYLOAD", "Mission control payload is invalid JSON"); }
  }

  writeArtifact({ missionId, kind, content }) {
    validateId(missionId, "mission_id");
    validateString(kind, "artifact kind", 64);
    const envelope = { protocol: MISSION_ARTIFACT_PROTOCOL, schema_version: 1, mission_id: missionId, kind, content };
    const bytes = Buffer.from(`${canonical(envelope)}\n`, "utf8");
    if (bytes.length > MAX_PAYLOAD_BYTES) throw new MissionControllerError("MISSION_ARTIFACT_TOO_LARGE", "Mission artifact exceeds byte bound", { status: "REJECTED" });
    const hash = digest(bytes);
    const location = `mission-control/artifacts/${missionId}/${hash}.json`;
    writeExclusive(path.join(this.stateDir, ...location.split("/")), bytes);
    return { sha256: `sha256:${hash}`, location, scope: "MISSION", kind };
  }

  assertArtifact(ref, { missionId, kind = null } = {}) {
    const checked = validateArtifactRef(ref, "artifact_ref", { missionId, kind });
    const file = path.join(this.stateDir, ...checked.location.split("/"));
    try { ensureRegularFile(file, "Mission artifact"); } catch (error) { if (error?.code === "ENOENT") throw new MissionControllerError("MISSING_MISSION_ARTIFACT", "Mission artifact is missing"); throw error; }
    const bytes = fs.readFileSync(file);
    if (`sha256:${digest(bytes)}` !== checked.sha256) throw new MissionControllerError("CORRUPT_MISSION_ARTIFACT", "Mission artifact digest mismatch");
    let envelope;
    try { envelope = JSON.parse(bytes.toString("utf8")); } catch { throw new MissionControllerError("CORRUPT_MISSION_ARTIFACT", "Mission artifact is invalid JSON"); }
    exactKeys(envelope, ["protocol", "schema_version", "mission_id", "kind", "content"], "Mission artifact");
    if (envelope.protocol !== MISSION_ARTIFACT_PROTOCOL || envelope.schema_version !== 1 || envelope.mission_id !== missionId || envelope.kind !== checked.kind) {
      throw new MissionControllerError("CORRUPT_MISSION_ARTIFACT", "Mission artifact identity is inconsistent");
    }
    return clone(envelope);
  }

  makeOperatorEvent(value, payloadRef, mission = null) {
    return {
      protocol: OPERATOR_EVENT_PROTOCOL,
      schema_version: 1,
      event_id: value.event_id,
      request_id: value.request_id,
      idempotency_key: value.idempotency_key,
      kind: mission ? "operator.followup.submitted" : "operator.request.submitted",
      occurred_at: value.occurred_at,
      source: value.source,
      subject: { mission_id: mission?.mission_id || null },
      intent: mission?.intent || value.intent,
      requested_authority: mission ? authorityClassFor(mission) : value.requested_authority,
      payload_ref: payloadRef,
      correlation_id: value.correlation_id,
    };
  }

  submit(requestInput) {
    const request = validateMissionRequest(requestInput);
    this.checkAuthority({ action: "CREATE", actor: request.actor, requestedAuthority: request.requested_authority });
    const payloadRef = this.payloadRefFor(request);
    const receipt = this.store.submitOperatorEvent(this.makeOperatorEvent(request, payloadRef));
    if (!new Set(["APPLIED", "DUPLICATE"]).has(receipt.status)) return receipt;
    const mission = this.inspect(receipt.mission_id);
    return { ...receipt, state_revision: mission.revision, snapshot_hash: mission.snapshot_hash };
  }

  inspect(missionId) {
    validateId(missionId, "mission_id");
    const sourceMission = this.store.readMission(missionId);
    if (!sourceMission) return null;
    const events = this.store.listEvents({ missionId });
    if (events.length > MAX_EVENTS) throw new MissionControllerError("MISSION_EVENT_BOUND_EXCEEDED", "Mission event bound exceeded");
    const initialEvent = events.find((event) => event.event_id === sourceMission.initial_event_id && event.status === "APPLIED");
    if (!initialEvent) throw new MissionControllerError("CORRUPT_MISSION_PROJECTION", "Mission initial Event is unavailable");
    const request = validateMissionRequest(this.readPayload(initialEvent.event.payload_ref));
    if (request.event_id !== initialEvent.event_id || request.request_id !== initialEvent.request_id) throw new MissionControllerError("CORRUPT_MISSION_PROJECTION", "initial request identity mismatch");
    let projection = {
      protocol: MISSION_CONTROL_PROJECTION_PROTOCOL,
      schema_version: 1,
      mission_id: missionId,
      request_id: sourceMission.initial_request_id,
      intent: sourceMission.intent,
      authority_ceiling: sourceMission.authority_ceiling,
      status: "CREATED",
      revision: 1,
      goal: {
        ...request.goal,
        status: "OPEN",
        revision: 0,
        last_verification_episode_id: null,
        evidence_refs: [],
      },
      active_episode: null,
      episodes: [],
      context_events: [],
      deferred_commands: [],
      last_event_id: initialEvent.event_id,
      last_event_at: request.occurred_at,
      source_mission_snapshot_hash: sourceMission.snapshot_hash,
      source_last_journal_seq: sourceMission.last_journal_seq,
      result_id: sourceMission.result_id,
      result_status: sourceMission.result_status,
      snapshot_hash: null,
    };
    projection.snapshot_hash = projectionHash(projection);

    const applied = [];
    const deferred = [];
    for (const event of events) {
      if (event.event_id === initialEvent.event_id || event.kind !== "operator.followup.submitted") continue;
      let command;
      try { command = validateMissionCommand(this.readPayload(event.event.payload_ref)); }
      catch (error) {
        throw new MissionControllerError("CORRUPT_MISSION_PROJECTION", `typed command ${event.event_id} is invalid: ${error?.code || error?.message}`);
      }
      if (command.mission_id !== missionId || command.event_id !== event.event_id || command.request_id !== event.request_id) {
        throw new MissionControllerError("CORRUPT_MISSION_PROJECTION", "command/Event exact identity mismatch");
      }
      this.assertCommandArtifacts(command);
      if (event.status === "APPLIED") applied.push({ event, command });
      else if (event.status === "DEFERRED") deferred.push({ event, command });
    }
    applied.sort((a, b) => a.event.journal_seq - b.event.journal_seq);
    for (const { command } of applied) projection = commandSemanticApply(projection, command, { reducing: true });
    projection.deferred_commands = deferred
      .sort((a, b) => a.event.records[0] - b.event.records[0])
      .map(({ event, command }) => ({ event_id: event.event_id, action: command.action, admitted_journal_seq: event.records[0], reason_code: event.reason_code }));
    projection.source_mission_snapshot_hash = sourceMission.snapshot_hash;
    projection.source_last_journal_seq = sourceMission.last_journal_seq;
    projection.result_id = sourceMission.result_id;
    projection.result_status = sourceMission.result_status;
    if (sourceMission.result_status && projection.status !== sourceMission.result_status) {
      throw new MissionControllerError("MISSION_RESULT_PROJECTION_MISMATCH", "MissionResult status disagrees with the typed lifecycle projection");
    }
    const result = this.store.readMissionResult(missionId);
    if (result) {
      const terminal = applied.at(-1)?.command;
      if (!terminal || !new Set(["CANCEL", "COMPLETE"]).has(terminal.action)) throw new MissionControllerError("MISSION_RESULT_PROJECTION_MISMATCH", "MissionResult has no terminal command");
      const expected = this.completionInput(projection, terminal, projection.status);
      if (Object.keys(expected).some((key) => canonical(result[key]) !== canonical(expected[key]))) throw new MissionControllerError("MISSION_RESULT_PROJECTION_MISMATCH", "MissionResult content disagrees with the terminal command");
    }
    projection.snapshot_hash = projectionHash(projection);
    return clone(projection);
  }

  listMissions({ limit = 256 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1024) throw new MissionControllerError("INVALID_MISSION_LIMIT", "Mission list limit is invalid", { status: "REJECTED" });
    const missions = this.store.listMissions()
      .slice(0, limit)
      .map((mission) => this.inspect(mission.mission_id));
    return {
      protocol: "devexec.mission-control-list",
      schema_version: 1,
      missions,
      bounded: true,
      truncated: this.store.listMissions().length > limit,
    };
  }

  listEvents(missionId, { after = 0, limit = 256 } = {}) {
    validateId(missionId, "mission_id");
    if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1024) throw new MissionControllerError("INVALID_EVENT_CURSOR", "event cursor/limit is invalid", { status: "REJECTED" });
    const events = this.store.listEvents({ missionId })
      .filter((event) => event.journal_seq > after)
      .sort((a, b) => a.journal_seq - b.journal_seq)
      .slice(0, limit)
      .map((event) => ({ ...event, cursor: event.journal_seq }));
    return { mission_id: missionId, events, next_cursor: events.at(-1)?.cursor || after, bounded: true };
  }

  listEpisodes(missionId, { after = 0, limit = 256 } = {}) {
    const projection = this.inspect(missionId);
    if (!projection) return null;
    if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1024) throw new MissionControllerError("INVALID_EPISODE_CURSOR", "episode cursor/limit is invalid", { status: "REJECTED" });
    const episodes = projection.episodes.slice(after, after + limit);
    return { mission_id: missionId, state_revision: projection.revision, episodes, next_cursor: after + episodes.length, bounded: true };
  }

  result(missionId) {
    const projection = this.inspect(missionId);
    if (!projection) return null;
    const result = this.store.readMissionResult(missionId);
    return result || { protocol: "devexec.mission-result-status", schema_version: 1, mission_id: missionId, status: TERMINAL_MISSION_STATES.has(projection.status) ? "RECONCILIATION_REQUIRED" : "NOT_TERMINAL", state_revision: projection.revision, snapshot_hash: projection.snapshot_hash };
  }

  assertCommandArtifacts(command) {
    const kinds = { input_ref: "EPISODE_INPUT", parent_receipt_ref: "FRESH_CONTEXT_RECEIPT", output_ref: "EPISODE_OUTPUT", payload_ref: "FOLLOWUP_INPUT" };
    for (const [key, kind] of Object.entries(kinds)) {
      if (command.data[key]) this.assertArtifact(command.data[key], { missionId: command.mission_id, kind });
    }
  }

  validateCommandAgainstProjection(command, projection, { atBoundary = false } = {}) {
    this.assertCommandArtifacts(command);
    if (command.expected_revision !== projection.revision && !atBoundary) throw new MissionControllerError("STALE_MISSION_OBSERVATION", `expected revision ${command.expected_revision}, observed ${projection.revision}`);
    if (command.action === "START_EPISODE") {
      const rank = { READ_ONLY: 0, BOUNDED_WRITE: 1 };
      if (rank[command.data.execution_authority] > rank[projection.authority_ceiling] || (projection.intent === "CONSULTATION" && command.data.execution_authority !== "READ_ONLY")) {
        throw new MissionControllerError("EPISODE_AUTHORITY_EXCEEDED", "Episode execution authority exceeds the Mission ceiling");
      }
      this.assertArtifact(command.data.input_ref, { missionId: command.mission_id, kind: "EPISODE_INPUT" });
      this.assertArtifact(command.data.parent_receipt_ref, { missionId: command.mission_id, kind: "FRESH_CONTEXT_RECEIPT" });
      if (typeof this.verifyFreshContext !== "function") throw new MissionControllerError("FRESH_CONTEXT_VERIFIER_REQUIRED", "Episode start requires an injected parent freshness verifier");
      let proof;
      try { proof = this.verifyFreshContext({ mission: clone(projection), episode: clone(command.data), actor: clone(command.actor) }); }
      catch (error) { throw new MissionControllerError("FRESH_CONTEXT_VERIFICATION_FAILED", String(error?.message || error)); }
      if (!isObject(proof) || proof.verified !== true || proof.receipt_sha256 !== command.data.parent_receipt_ref.sha256) {
        throw new MissionControllerError("FRESH_CONTEXT_NOT_VERIFIED", "parent freshness receipt was not verified");
      }
    }
    if (command.action === "FOLLOWUP") this.assertArtifact(command.data.payload_ref, { missionId: command.mission_id, kind: "FOLLOWUP_INPUT" });
    if (command.action === "COMPLETE_EPISODE") this.assertArtifact(command.data.output_ref, { missionId: command.mission_id, kind: "EPISODE_OUTPUT" });
    return commandSemanticApply(projection, command);
  }

  coreSubmit(event) {
    return CoreMissionStore.prototype.submitOperatorEvent.call(this.store, event);
  }

  coreApply(input) {
    return CoreMissionStore.prototype.applyDeferredEvent.call(this.store, input);
  }

  coreComplete(missionId, input) {
    if (this.store.readMission(missionId).deferred_event_ids.length) throw new MissionControllerError("DEFERRED_EVENTS_PENDING", "MissionResult cannot abandon admitted Events");
    return CoreMissionStore.prototype.completeMission.call(this.store, missionId, input);
  }

  completionInput(projection, command, status = "COMPLETE") {
    return {
      status,
      summary: command.data.summary || command.data.reason,
      changed_surface: status === "COMPLETE" ? command.data.changed_surface : [],
      evidence_refs: command.data.evidence_refs,
      remaining_limits: status === "COMPLETE" ? command.data.remaining_limits : [],
      episode_aggregate: {
        episode_count: projection.episodes.length,
        runtime_classes: [...new Set(projection.episodes.map((episode) => episode.runtime_class))],
        escalation_count: projection.episodes.filter((episode) => new Set(["BLOCKED", "NEEDS_CONTEXT"]).has(episode.status)).length,
      },
    };
  }

  // Caller owns the public store's single Mission transition lock. Recovery
  // replays admitted commands only; it never dispatches worker side effects.
  #reconcileLocked(missionId) {
    let projection = this.inspect(missionId);
    if (!projection) throw new MissionControllerError("MISSION_NOT_FOUND", "Mission not found");
    for (let step = 0; step < MAX_EVENTS && projection.deferred_commands.length; step += 1) {
      const pending = projection.active_episode
        ? projection.deferred_commands.find((item) => item.action === "COMPLETE_EPISODE")
        : projection.deferred_commands[0];
      if (!pending) break;
      const event = this.store.readEvent(pending.event_id);
      const command = validateMissionCommand(this.readPayload(event.event.payload_ref));
      this.checkAuthority({ action: command.action, mission: projection, actor: command.actor, requestedAuthority: authorityClassFor(projection) });
      this.validateCommandAgainstProjection(command, projection, { atBoundary: new Set(["FOLLOWUP", "PAUSE", "CANCEL", "COMPLETE"]).has(command.action) });
      this.coreApply({ mission_id: missionId, event_id: command.event_id, safe_boundary: "FRESH_NEXT_EPISODE" });
      projection = this.inspect(missionId);
    }
    if (TERMINAL_MISSION_STATES.has(projection.status) && !this.store.readMissionResult(missionId)) {
      if (projection.deferred_commands.length) throw new MissionControllerError("DEFERRED_EVENTS_PENDING", "terminal reconciliation cannot abandon admitted Events");
      const terminal = this.store.readEvent(projection.last_event_id);
      const command = validateMissionCommand(this.readPayload(terminal.event.payload_ref));
      if (terminal.status !== "APPLIED" || !new Set(["CANCEL", "COMPLETE"]).has(command.action)) throw new MissionControllerError("CORRUPT_MISSION_PROJECTION", "terminal reconciliation requires the exact APPLIED terminal command");
      this.checkAuthority({ action: command.action, mission: projection, actor: command.actor, requestedAuthority: authorityClassFor(projection) });
      this.coreComplete(missionId, this.completionInput(projection, command, projection.status));
      projection = this.inspect(missionId);
    }
    return projection;
  }

  reconcile(missionId) {
    validateId(missionId, "mission_id");
    return this.store.withMissionTransition(missionId, () => this.#reconcileLocked(missionId));
  }

  control(commandInput) {
    const command = validateMissionCommand(commandInput);
    const initial = this.inspect(command.mission_id);
    if (!initial) throw new MissionControllerError("MISSION_NOT_FOUND", "Mission not found", { status: "REJECTED" });
    requireRole(command);
    if (initial.intent === "CONSULTATION" && new Set(["START_EPISODE"]).has(command.action) && command.data.axis === "TASK_EXECUTION" && command.data.role === "WORKER") {
      // A consultation may execute bounded read-only analysis, but the durable
      // authority validator still receives READ_ONLY and must reject mutation.
    }
    this.checkAuthority({ action: command.action, mission: initial, actor: command.actor, requestedAuthority: authorityClassFor(initial) });

    return this.store.withMissionTransition(command.mission_id, () => {
      let projection = this.inspect(command.mission_id);
      let admitted = this.store.readEvent(command.event_id);
      if (admitted) {
        const admittedCommand = validateMissionCommand(this.readPayload(admitted.event.payload_ref));
        if (canonical(admittedCommand) !== canonical(command) || admitted.mission_id !== command.mission_id) {
          throw new MissionControllerError("MISSION_COMMAND_REPLAY_CONFLICT", "concurrent event_id replay changed command content or Mission binding");
        }
        projection = this.#reconcileLocked(command.mission_id);
        admitted = this.store.readEvent(command.event_id);
        return {
          protocol: "devexec.event-receipt",
          schema_version: 1,
          event_id: command.event_id,
          request_id: command.request_id,
          mission_id: command.mission_id,
          status: "DUPLICATE",
          canonical_status: admitted.status,
          reason_code: "EVENT_ALREADY_ADMITTED",
          idempotency_digest: admitted.idempotency_digest,
          journal_seq: admitted.journal_seq,
          state_revision: projection.revision,
          snapshot_hash: projection.snapshot_hash,
          mission_result: this.store.readMissionResult(command.mission_id),
        };
      }
      if (command.expected_revision !== projection.revision) throw new MissionControllerError("STALE_MISSION_OBSERVATION", `expected revision ${command.expected_revision}, observed ${projection.revision}`);
      if (projection.deferred_commands.length && !new Set(["COMPLETE_EPISODE"]).has(command.action)) {
        throw new MissionControllerError("CONTROL_ALREADY_PENDING", "a deferred Mission control already owns the next safe boundary");
      }
      let projected;
      try { projected = this.validateCommandAgainstProjection(command, projection); }
      catch (error) {
        if (!(error instanceof MissionControllerError) || error.status !== "DEFERRED") throw error;
        projected = null;
      }
      const payloadRef = this.payloadRefFor(command);
      const event = this.makeOperatorEvent(command, payloadRef, this.store.readMission(command.mission_id));
      const receipt = this.coreSubmit(event);
      if (receipt.status === "DUPLICATE") {
        projection = this.inspect(command.mission_id);
        return { ...receipt, state_revision: projection.revision, snapshot_hash: projection.snapshot_hash };
      }
      if (receipt.status !== "DEFERRED") return receipt;
      if (projected === null) {
        return { ...receipt, state_revision: projection.revision, snapshot_hash: projection.snapshot_hash };
      }
      const applied = this.coreApply({ mission_id: command.mission_id, event_id: command.event_id, safe_boundary: "FRESH_NEXT_EPISODE" });
      projection = this.inspect(command.mission_id);
      if (command.action === "CANCEL") {
        const completed = this.coreComplete(command.mission_id, this.completionInput(projection, command, "CANCELLED"));
        projection = this.inspect(command.mission_id);
        return { ...applied, mission_result: completed.result, state_revision: projection.revision, snapshot_hash: projection.snapshot_hash };
      }
      if (command.action === "COMPLETE") {
        const completed = this.coreComplete(command.mission_id, this.completionInput(projection, command, "COMPLETE"));
        projection = this.inspect(command.mission_id);
        return { ...applied, mission_result: completed.result, state_revision: projection.revision, snapshot_hash: projection.snapshot_hash };
      }
      if (command.action === "COMPLETE_EPISODE") projection = this.#reconcileLocked(command.mission_id);
      return { ...applied, state_revision: projection.revision, snapshot_hash: projection.snapshot_hash, mission_status: projection.status };
    });
  }
}

export function createDevExecMissionController(options) {
  return new DevExecMissionController(options);
}

export function wrapMissionControllerError(error) {
  if (error instanceof MissionControllerError) return error;
  if (error instanceof MissionCoreError) return new MissionControllerError(error.code, error.message, { status: error.status || "BLOCKED" });
  return new MissionControllerError("MISSION_CONTROL_FAILURE", String(error?.message || error));
}
