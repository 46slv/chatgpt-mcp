import {assertMissionId} from "./devexec-mission-state.mjs";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertRunId(value, name) {
  if (typeof value !== "string" || !SAFE_RUN_ID.test(value)) throw new Error(`invalid ${name}`);
  return value;
}

export function resolveMissionEntryIdentity({
  run_id,
  parent_run_id = null,
  mission_id = null,
} = {}) {
  const runId = assertRunId(run_id, "run_id");
  const parentRunId = parent_run_id == null ? null : assertRunId(parent_run_id, "parent_run_id");
  let missionId = mission_id;
  if (missionId == null || missionId === "") {
    if (parentRunId !== null) throw new Error("DEV_EXEC_MISSION_ID_REQUIRED_FOR_CHILD");
    missionId = runId;
  }
  missionId = assertMissionId(missionId);
  return {
    mission_id: missionId,
    run_id: runId,
    parent_run_id: parentRunId,
  };
}
