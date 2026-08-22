import {withMissionLock} from "./devexec-mission-lock.mjs";
import {loadMissionState, resolveMissionPaths, saveMissionState} from "./devexec-mission-state.mjs";

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} required`);
  return value.trim();
}

function findRun(state, runId) {
  return state.runs.find(run => run.run_id === runId) ?? null;
}

function loadBoundParent(paths, missionId, parentRunId) {
  const state = loadMissionState(paths.state_file);
  if (state.mission_id !== missionId) throw new Error("MISSION_STATE_ID_MISMATCH");
  if (state.current_run_id !== parentRunId) throw new Error("STALE_PARENT_RUN_ID");
  return state;
}

export function reserveMissionChildRun({
  base,
  mission_id,
  run_id,
  parent_run_id,
  now = new Date().toISOString(),
} = {}) {
  const missionId = required(mission_id, "mission_id");
  const runId = required(run_id, "run_id");
  const parentRunId = required(parent_run_id, "parent_run_id");
  const paths = resolveMissionPaths(base, missionId);

  return withMissionLock(paths.root, () => {
    const state = loadBoundParent(paths, missionId, parentRunId);
    const existing = findRun(state, runId);
    if (existing) {
      if (existing.parent_run_id !== parentRunId) throw new Error("RUN_LINEAGE_CONFLICT");
      if (existing.status === "RESERVED") return {state, run: existing, deduplicated: true, paths};
      if (existing.status === "STARTING") throw new Error("MISSION_CHILD_START_IN_FLIGHT");
      if (existing.status === "AMBIGUOUS") throw new Error("MISSION_CHILD_START_AMBIGUOUS");
      throw new Error("CHILD_RUN_ID_ALREADY_EXISTS");
    }

    const run = {
      run_id: runId,
      parent_run_id: parentRunId,
      status: "RESERVED",
      reserved_at: now,
      start_attempt_id: null,
      start_started_at: null,
      attached_at: null,
      ambiguous_reason: null,
    };
    state.runs.push(run);
    state.revision += 1;
    state.updated_at = now;
    saveMissionState(paths.state_file, state);
    return {state, run, deduplicated: false, paths};
  });
}

export function beginMissionChildRunStart({
  base,
  mission_id,
  run_id,
  parent_run_id,
  start_attempt_id,
  now = new Date().toISOString(),
} = {}) {
  const missionId = required(mission_id, "mission_id");
  const runId = required(run_id, "run_id");
  const parentRunId = required(parent_run_id, "parent_run_id");
  const attemptId = required(start_attempt_id, "start_attempt_id");
  const paths = resolveMissionPaths(base, missionId);

  return withMissionLock(paths.root, () => {
    const state = loadBoundParent(paths, missionId, parentRunId);
    const run = findRun(state, runId);
    if (!run) throw new Error("MISSION_CHILD_NOT_RESERVED");
    if (run.parent_run_id !== parentRunId) throw new Error("RUN_LINEAGE_CONFLICT");
    if (run.status === "STARTING") {
      if (run.start_attempt_id === attemptId) return {state, run, deduplicated: true, paths};
      throw new Error("MISSION_CHILD_START_IN_FLIGHT");
    }
    if (run.status === "AMBIGUOUS") throw new Error("MISSION_CHILD_START_AMBIGUOUS");
    if (run.status !== "RESERVED") throw new Error(`mission child not reserved: ${run.status ?? "UNKNOWN"}`);

    run.status = "STARTING";
    run.start_attempt_id = attemptId;
    run.start_started_at = now;
    state.revision += 1;
    state.updated_at = now;
    saveMissionState(paths.state_file, state);
    return {state, run, deduplicated: false, paths};
  });
}

export function activateMissionChildRun({
  base,
  mission_id,
  run_id,
  parent_run_id,
  start_attempt_id,
  now = new Date().toISOString(),
} = {}) {
  const missionId = required(mission_id, "mission_id");
  const runId = required(run_id, "run_id");
  const parentRunId = required(parent_run_id, "parent_run_id");
  const attemptId = required(start_attempt_id, "start_attempt_id");
  const paths = resolveMissionPaths(base, missionId);

  return withMissionLock(paths.root, () => {
    const state = loadBoundParent(paths, missionId, parentRunId);
    const run = findRun(state, runId);
    if (!run) throw new Error("MISSION_CHILD_NOT_RESERVED");
    if (run.parent_run_id !== parentRunId) throw new Error("RUN_LINEAGE_CONFLICT");
    if (run.status !== "STARTING") throw new Error(`mission child not starting: ${run.status ?? "UNKNOWN"}`);
    if (run.start_attempt_id !== attemptId) throw new Error("MISSION_CHILD_START_ATTEMPT_MISMATCH");

    run.status = "ACTIVE";
    run.attached_at = now;
    state.current_run_id = runId;
    state.revision += 1;
    state.updated_at = now;
    saveMissionState(paths.state_file, state);
    return {state, run, paths};
  });
}

export function markMissionChildRunAmbiguous({
  base,
  mission_id,
  run_id,
  parent_run_id,
  start_attempt_id,
  reason,
  now = new Date().toISOString(),
} = {}) {
  const missionId = required(mission_id, "mission_id");
  const runId = required(run_id, "run_id");
  const parentRunId = required(parent_run_id, "parent_run_id");
  const attemptId = required(start_attempt_id, "start_attempt_id");
  const ambiguityReason = required(reason, "reason");
  const paths = resolveMissionPaths(base, missionId);

  return withMissionLock(paths.root, () => {
    const state = loadBoundParent(paths, missionId, parentRunId);
    const run = findRun(state, runId);
    if (!run) throw new Error("MISSION_CHILD_NOT_RESERVED");
    if (run.parent_run_id !== parentRunId) throw new Error("RUN_LINEAGE_CONFLICT");
    if (run.status !== "STARTING" || run.start_attempt_id !== attemptId) {
      throw new Error("MISSION_CHILD_START_ATTEMPT_MISMATCH");
    }

    run.status = "AMBIGUOUS";
    run.ambiguous_reason = ambiguityReason;
    state.revision += 1;
    state.updated_at = now;
    saveMissionState(paths.state_file, state);
    return {state, run, paths};
  });
}
