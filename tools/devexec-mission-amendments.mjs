import fs from "node:fs";
import path from "node:path";

const KINDS = new Set(["MISSION_AMENDMENT", "GOAL_PATCH"]);
const APPLY_MODES = new Set(["next_safe_boundary", "after_current_goal", "supersede_current_goal"]);
const TERMINAL = new Set(["APPLIED", "REJECTED", "CANCELLED"]);

function assertNonEmpty(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} required`);
  return value.trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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
  if (existing) return {queue, amendment: existing, deduplicated: true};

  const id = assertNonEmpty(input.amendment_id, "amendment_id");
  if (queue.amendments.some(item => item.amendment_id === id)) throw new Error("duplicate amendment_id");

  const amendment = {
    amendment_id: id,
    idempotency_key: idempotencyKey,
    kind: input.kind,
    apply_mode: input.apply_mode,
    priority: Number.isInteger(input.priority) ? input.priority : 0,
    payload: clone(input.payload ?? {}),
    status: "PENDING",
    created_at: now,
    created_for_run_id: input.run_id ?? queue.current_run_id,
    applied_at: null,
    applied_run_id: null,
    disposition_reason: null,
  };
  queue.amendments.push(amendment);
  queue.revision += 1;
  return {queue, amendment, deduplicated: false};
}

export function setAmendmentDisposition(queue, amendmentId, status, {reason = null, now = new Date().toISOString()} = {}) {
  if (!TERMINAL.has(status)) throw new Error("invalid amendment disposition");
  const item = queue.amendments.find(entry => entry.amendment_id === amendmentId);
  if (!item) throw new Error("amendment not found");
  if (item.status !== "PENDING") throw new Error("amendment already terminal");
  item.status = status;
  item.disposition_reason = reason;
  if (status === "APPLIED") item.applied_at = now;
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

export function applyAmendment(queue, amendmentId, boundary, {now = new Date().toISOString()} = {}) {
  const applicable = selectApplicableAmendments(queue, boundary);
  const selected = applicable.find(item => item.amendment_id === amendmentId);
  if (!selected) throw new Error("amendment not applicable at this boundary");
  const item = queue.amendments.find(entry => entry.amendment_id === amendmentId);
  item.status = "APPLIED";
  item.applied_at = now;
  item.applied_run_id = boundary.run_id ?? queue.current_run_id ?? null;
  queue.revision += 1;
  return item;
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
  if (!Array.isArray(queue.amendments)) throw new Error("invalid amendment queue amendments");
  return queue;
}
