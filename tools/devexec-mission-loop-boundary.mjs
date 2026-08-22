import crypto from "node:crypto";

import {openMissionControl} from "./devexec-mission-control.mjs";
import {applyApplicableMissionObjectiveAmendments} from "./devexec-mission-amendment-runtime.mjs";
import {readMissionObjective} from "./devexec-mission-objective.mjs";
import {readMissionLaunchState, requestMissionChildLaunch} from "./devexec-mission-launch.mjs";

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} required`);
  return value.trim();
}

function stableId(prefix, parts) {
  const digest = crypto.createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 20);
  return `${prefix}-${digest}`;
}

function summarizeApplied(entry) {
  return {
    amendment_id: entry.amendment.amendment_id,
    apply_attempt_id: entry.apply_attempt_id,
    deduplicated: entry.mutation?.deduplicated === true,
  };
}

function workIdempotencyKey(work, index) {
  return `mission-objective:${work.amendment_id}:${work.apply_attempt_id}:${index}`;
}

function continuationIdentity(missionId, runId, work, index) {
  const parts = [
    missionId,
    runId,
    work.amendment_id,
    work.apply_attempt_id,
    String(index),
    work.text,
  ];
  return {
    child_run_id: stableId("DEV-EXEC-CONT", parts),
    launch_id: stableId("MISSION-LAUNCH", parts),
    idempotency_key: workIdempotencyKey(work, index),
  };
}

function workConstraintTexts(work) {
  const values = work?.constraints ?? [];
  if (!Array.isArray(values)) throw new Error("objective work constraints must be an array");
  const seen = new Set();
  const result = [];
  for (let index = 0; index < values.length; index += 1) {
    const text = required(values[index], `objective work constraints[${index}]`);
    if (seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function findContinuationWork(control, objective, runId) {
  const launchState = readMissionLaunchState(control);
  for (let index = 0; index < objective.queued_work.length; index += 1) {
    const work = objective.queued_work[index];
    const idempotencyKey = workIdempotencyKey(work, index);
    const existing = launchState.launches.find(launch => launch.idempotency_key === idempotencyKey) ?? null;
    if (!existing) return {work, index, existing: null};
    if (existing.parent_run_id === runId) return {work, index, existing};
  }
  return null;
}

function summarizeExistingContinuation(existing, work, index) {
  return {
    child_run_id: existing.child_run_id,
    launch_id: existing.launch_id,
    idempotency_key: existing.idempotency_key,
    goal: work.text,
    constraints: [...(existing.constraints ?? [])],
    objective_index: index,
    status: existing.status,
    deduplicated: true,
  };
}

export function applyMissionLoopBoundary({
  base,
  mission_id,
  run_id,
  parent_run_id = null,
  current_goal_complete = false,
  pending_action = false,
  ambiguous_action = false,
  target_alias = null,
  now = new Date().toISOString(),
} = {}) {
  if (mission_id == null || mission_id === "") {
    return {
      enabled: false,
      applied: [],
      skipped: [],
      objective: null,
      continuation: null,
    };
  }

  const missionId = required(mission_id, "mission_id");
  const runId = required(run_id, "run_id");
  const control = openMissionControl({
    base,
    mission_id: missionId,
    run_id: runId,
    parent_run_id,
    now,
  });
  const boundary = {
    safe: true,
    pending_action: pending_action === true,
    ambiguous_action: ambiguous_action === true,
    current_goal_complete: current_goal_complete === true,
  };

  const result = applyApplicableMissionObjectiveAmendments(control, boundary, {base, now});
  const objective = readMissionObjective({base, mission_id: missionId});
  let continuation = null;

  if (boundary.current_goal_complete && !boundary.pending_action && !boundary.ambiguous_action) {
    const candidate = findContinuationWork(control, objective, runId);
    if (candidate) {
      const {work, index, existing} = candidate;
      if (existing) {
        continuation = summarizeExistingContinuation(existing, work, index);
      } else {
        const identity = continuationIdentity(missionId, runId, work, index);
        const constraints = workConstraintTexts(work);
        const requested = requestMissionChildLaunch(control, {
          parent_run_id: runId,
          child_run_id: identity.child_run_id,
          launch_id: identity.launch_id,
          idempotency_key: identity.idempotency_key,
          goal: work.text,
          constraints,
          target_alias,
        }, {boundary, now});
        continuation = {
          ...identity,
          goal: work.text,
          constraints,
          objective_index: index,
          status: requested.launch.status,
          deduplicated: requested.deduplicated === true,
        };
      }
    }
  }

  return {
    enabled: true,
    mission_id: missionId,
    run_id: runId,
    boundary,
    applied: result.applied.map(summarizeApplied),
    skipped: result.skipped.map(item => ({...item})),
    objective,
    continuation,
  };
}
