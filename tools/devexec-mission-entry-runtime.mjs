import crypto from "node:crypto";

import {openMissionControl} from "./devexec-mission-control.mjs";
import {reconcileMissionChildLaunches} from "./devexec-mission-launch.mjs";
import {
  activateMissionChildRun,
  activateMissionRootRun,
  beginMissionChildRunStart,
  beginMissionRootRunStart,
  markMissionChildRunAmbiguous,
  markMissionRootRunAmbiguous,
  reserveMissionChildRun,
} from "./devexec-mission-run-admission.mjs";

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} required`);
  return value.trim();
}

function assertAgentResult(agent) {
  if (!agent || typeof agent !== "object" || typeof agent.run_id !== "string" || !agent.run_id.trim()) {
    throw new Error("LOCAL_AGENT_START_RESULT_INVALID");
  }
  return agent;
}

export function startMissionLocalAgent({
  base,
  identity,
  start_local_agent,
  start_attempt_id = crypto.randomUUID(),
  now = new Date().toISOString(),
} = {}) {
  if (!identity || typeof identity !== "object") throw new Error("mission identity required");
  const missionId = required(identity.mission_id, "mission_id");
  const runId = required(identity.run_id, "run_id");
  const parentRunId = identity.parent_run_id == null ? null : required(identity.parent_run_id, "parent_run_id");
  if (typeof start_local_agent !== "function") throw new Error("start_local_agent required");

  if (parentRunId === null) {
    const opened = openMissionControl({base, mission_id: missionId, run_id: runId, now});
    const begun = beginMissionRootRunStart({
      base,
      mission_id: missionId,
      run_id: runId,
      start_attempt_id,
      now,
    });
    if (begun.deduplicated) throw new Error("MISSION_ROOT_START_ALREADY_IN_FLIGHT");

    let agent;
    try {
      agent = start_local_agent();
      if (agent && typeof agent.then === "function") throw new Error("LOCAL_AGENT_ASYNC_START_UNSUPPORTED");
      assertAgentResult(agent);
    } catch (error) {
      markMissionRootRunAmbiguous({
        base,
        mission_id: missionId,
        run_id: runId,
        start_attempt_id,
        reason: `LOCAL_AGENT_START_AMBIGUOUS:${error?.message || String(error)}`,
        now,
      });
      throw error;
    }

    activateMissionRootRun({
      base,
      mission_id: missionId,
      run_id: runId,
      start_attempt_id,
      now,
    });
    const mission = openMissionControl({base, mission_id: missionId, run_id: runId, now});
    mission.created = opened.created;
    return {mission, agent, start_attempt_id, launch_reconciled: false};
  }

  reserveMissionChildRun({base, mission_id: missionId, run_id: runId, parent_run_id: parentRunId, now});
  const begun = beginMissionChildRunStart({
    base,
    mission_id: missionId,
    run_id: runId,
    parent_run_id: parentRunId,
    start_attempt_id,
    now,
  });
  if (begun.deduplicated) throw new Error("MISSION_CHILD_START_ALREADY_IN_FLIGHT");

  let agent;
  try {
    agent = start_local_agent();
    if (agent && typeof agent.then === "function") throw new Error("LOCAL_AGENT_ASYNC_START_UNSUPPORTED");
    assertAgentResult(agent);
  } catch (error) {
    markMissionChildRunAmbiguous({
      base,
      mission_id: missionId,
      run_id: runId,
      parent_run_id: parentRunId,
      start_attempt_id,
      reason: `LOCAL_AGENT_START_AMBIGUOUS:${error?.message || String(error)}`,
      now,
    });
    throw error;
  }

  activateMissionChildRun({
    base,
    mission_id: missionId,
    run_id: runId,
    parent_run_id: parentRunId,
    start_attempt_id,
    now,
  });
  const mission = openMissionControl({
    base,
    mission_id: missionId,
    run_id: runId,
    parent_run_id: parentRunId,
    now,
  });
  const reconciliation = reconcileMissionChildLaunches(mission, {now});
  return {mission, agent, start_attempt_id, launch_reconciled: reconciliation.changed};
}
