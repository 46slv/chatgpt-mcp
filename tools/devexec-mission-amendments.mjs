import fs from "node:fs";
import path from "node:path";

const KINDS = new Set(["MISSION_AMENDMENT", "GOAL_PATCH"]);
const APPLY_MODES = new Set(["next_safe_boundary", "after_current_goal", "supersede_current_goal"]);
const MANUAL_DISPOSITIONS = new Set(["REJECTED", "CANCELLED"]);

function assertNonEmpty(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} required`);
  return value.trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}

function semanticShape(input) {
  return {
    kind: input.kind,
    apply_mode: input.apply_mode,
    priority: Number.isInteger(input.priority) ? input.priority : 0,
    payload: stableValue(input.payload ?? {}),
  };
}

function sameSemanticRequest(existing, input) {
  const expected = semanticShape(input);
  const actual = {
    kind: existing.kind,
    apply_mode: existing.apply_mode,
    priority: existing.priority,
    payload: stableValue(existing.payload),
  };
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function findAmendment(queue, amendmentId) {
  const item = queue.amendments.find(entry => entry.amendment_id === amendmentId);
  if (!item) throw new Error("amendment not found");
  return item;
}

export function createAmendmentQueue({mission_id, run_id = null} = {}) {
  return {
    protocol: "devexec.mission-amendments",
    schema_version: 1,
    mission_id: assertNonEmpty(mission_id, "mission_id"),
    current_run_id: run_id == null ? null : assertNonEmpty(run_id, "run_id"),
    revision: 0,
    amendments: [],
  };
}

export function enqueueAmendment(queue, input, {now = new Date().toISOString()} = {}) {
  if (!queue || queue.protocol !== "devexec.mission-amendments") throw new Error("invalid amendment queue");
  if (!input || !KINDS.has(input.kind)) throw new Error("invalid amendment kind");
  if (!APPLY_MODES.has(input.apply_mode)) throw new Error("invalid amendment apply_mode");

  const idempotencyKey = assertNonEmpty(input.idempotency_key, "idempotency_key");
  const existing = queue.amendments.find(item => item.idempotency_key === idempotencyKey);
  if (existing) {
    if (!sameSemanticRequest(existing, input)) throw new Error("IDEMPOTENCY_KEY_CONFLICT");
    return {queue, amendment: existing, deduplicated: true};
  }

  const id = assertNonEmpty(input.amendment_id, "amendment_id");
  if (queue.amendments.some(item => item.amendment_id === id)) throw new Error("duplicate amendment_id");

  const shape = semanticShape(input);
  const amendment = {
    amendment_id: id,
    idempotency_key: idempotencyKey,
    ...shape,
    payload: clone(shape.payload),
    created_for_run_id: input.run_id ?? queue.current_run_id,
    status: "PENDING",
    created_at: now,
    apply_attempt_id: null,
    apply_started_at: null,
    applied_at: null,
    applied_run_id: null,
    disposition_reason: null,
  };
  queue.amendments.push(amendment);
  queue.revision += 1;
  return {queue, amendment, deduplicated: false};
}

export function setAmendmentDisposition(queue, amendmentId, status, {reason = null} = {}) {
  if (status === "APPLIED") throw new Error("APPLIED_REQUIRES_TWO_PHASE_APPLY");
  if (!MANUAL_DISPOSITIONS.has(status)) throw new Error("invalid amendment disposition");
  const item = findAmendment(queue, amendmentId);
  if (item.status !== "PENDING") throw new Error("amendment already terminal or in flight");
  item.status = status;
  item.disposition_reason = reason;
  queue.revision += 1;
  return item;
}

export function selectApplicableAmendments(queue, boundary) {
  if (!boundary || boundary.safe !== true) return [];
  if (boundary.pending_action === true || boundary.ambiguous_action === true) return [];
  const runId = boundary.run_id ?? queue.current_run_id ?? null;
  const currentGoalComplete = boundary.current_goal_complete === true;

  return queue.amendments
    .filter(item => item.status === "PENDING")
    .filter(item => {
      if (item.apply_mode === "next_safe_boundary") return true;
      if (item.apply_mode === "after_current_goal") return currentGoalComplete;
      if (item.apply_mode === "supersede_current_goal") return true;
      return false;
    })
    .sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at))
    .map(item => ({...clone(item), target_run_id: runId}));
}

export function beginAmendmentApply(queue, amendmentId, boundary, {apply_attempt_id, now = new Date().toISOString()} = {}) {
  const attemptId = assertNonEmpty(apply_attempt_id, "apply_attempt_id");
  const item = findAmendment(queue, amendmentId);
  if (item.status === "APPLYING") {
    if (item.apply_attempt_id === attemptId) return {amendment: item, deduplicated: true};
    throw new Error("AMENDMENT_APPLY_IN_FLIGHT");
  }
  if (item.status !== "PENDING") throw new Error("amendment not pending");
  const selected = selectApplicableAmendments(queue, boundary).find(entry => entry.amendment_id === amendmentId);
  if (!selected) throw new Error("amendment not applicable at this boundary");

  item.status = "APPLYING";
  item.apply_attempt_id = attemptId;
  item.apply_started_at = now;
  item.applied_run_id = selected.target_run_id;
  queue.revision += 1;
  return {amendment: item, deduplicated: false};
}

export function completeAmendmentApply(queue, amendmentId, {apply_attempt_id, now = new Date().toISOString()} = {}) {
  const attemptId = assertNonEmpty(apply_attempt_id, "apply_attempt_id");
  const item = findAmendment(queue, amendmentId);
  if (item.status === "APPLIED") {
    if (item.apply_attempt_id === attemptId) return {amendment: item, deduplicated: true};
    throw new Error("AMENDMENT_APPLY_ATTEMPT_MISMATCH");
  }
  if (item.status !== "APPLYING") throw new Error("amendment not applying");
  if (item.apply_attempt_id !== attemptId) throw new Error("AMENDMENT_APPLY_ATTEMPT_MISMATCH");
  item.status = "APPLIED";
  item.applied_at = now;
  queue.revision += 1;
  return {amendment: item, deduplicated: false};
}

export function applyAmendment(queue, amendmentId, boundary, {now = new Date().toISOString()} = {}) {
  const attemptId = `legacy-${amendmentId}`;
  beginAmendmentApply(queue, amendmentId, boundary, {apply_attempt_id: attemptId, now});
  return completeAmendmentApply(queue, amendmentId, {apply_attempt_id: attemptId, now}).amendment;
}

export function carryAmendmentsToRun(queue, runId) {
  queue.current_run_id = assertNonEmpty(runId, "run_id");
  queue.revision += 1;
  return queue;
}

export function saveAmendmentQueue(file, queue) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, {recursive: true});
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(queue, null, 2) + "\n", "utf8");
  fs.renameSync(temp, file);
}

export function loadAmendmentQueue(file) {
  const queue = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!queue || queue.protocol !== "devexec.mission-amendments" || queue.schema_version !== 1) {
    throw new Error("invalid amendment queue file");
  }
  assertNonEmpty(queue.mission_id, "mission_id");
  if (!Array.isArray(queue.amendments)) throw new Error("invalid amendment queue amendments");
  return queue;
}
