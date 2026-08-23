import {
  openMissionControl,
} from "./devexec-mission-control.mjs";
import {
  requestMissionChildLaunch,
} from "./devexec-mission-launch.mjs";
import {
  dispatchMissionChildLaunch,
} from "./devexec-mission-launcher.mjs";

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} required`);
  }

  return value.trim();
}

function normalizeConstraints(value) {
  if (value == null) return [];

  if (!Array.isArray(value)) {
    throw new Error("constraints must be an array");
  }

  return value.map((item, index) =>
    required(item, `constraints[${index}]`)
  );
}

function attemptIdFor(launchId) {
  return `${launchId}:autonomous-attempt`;
}

function requestIdFor(launchId) {
  return `${launchId}:autonomous-request`;
}

function noReplayResult(launch, requested) {
  return {
    status: launch.status,
    launch,
    request_deduplicated: requested.deduplicated === true,
    dispatched: false,
    replay_blocked: true,
  };
}

export async function startMissionRunAutonomously({
  base,
  mission_id,
  parent_run_id,
  child_run_id,
  goal,
  launch_id,
  idempotency_key,
  target_alias = null,
  constraints = [],
  boundary,
  entry_path,
  node_path = process.execPath,
  spawn_env = process.env,
} = {}, {
  open_control = openMissionControl,
  request_launch = requestMissionChildLaunch,
  dispatch_launch = dispatchMissionChildLaunch,
} = {}) {
  const missionId = required(mission_id, "mission_id");
  const parentRunId = required(parent_run_id, "parent_run_id");
  const childRunId = required(child_run_id, "child_run_id");
  const goalText = required(goal, "goal");
  const launchId = required(launch_id, "launch_id");
  const idempotencyKey = required(idempotency_key, "idempotency_key");
  const entryPath = required(entry_path, "entry_path");
  const normalizedConstraints = normalizeConstraints(constraints);

  if (!boundary || boundary.safe !== true) {
    throw new Error("MISSION_AUTONOMOUS_START_UNSAFE_BOUNDARY");
  }

  if (
    boundary.pending_action === true ||
    boundary.ambiguous_action === true
  ) {
    throw new Error(
      "MISSION_AUTONOMOUS_START_BLOCKED_BY_IN_FLIGHT_ACTION"
    );
  }

  const control = open_control({
    base,
    mission_id: missionId,
    run_id: parentRunId,
  });

  if (control.state.current_run_id !== parentRunId) {
    throw new Error("MISSION_AUTONOMOUS_START_STALE_PARENT");
  }

  const requested = request_launch(
    control,
    {
      launch_id: launchId,
      idempotency_key: idempotencyKey,
      parent_run_id: parentRunId,
      child_run_id: childRunId,
      goal: goalText,
      constraints: normalizedConstraints,
      target_alias,
    },
    {
      boundary,
    },
  );

  const launch = requested.launch;

  if (!launch || launch.launch_id !== launchId) {
    throw new Error("MISSION_AUTONOMOUS_START_INVALID_LAUNCH");
  }

  /*
   * The launch intent is durable before this function crosses the child-spawn
   * side-effect boundary because requestMissionChildLaunch persists PENDING
   * under the Mission lock.
   *
   * A restart that observes LAUNCHING must never spawn again. Existing Mission
   * launcher recovery owns that ambiguous boundary, so this public wrapper
   * returns the durable state without replaying it.
   */
  if (launch.status === "LAUNCHING") {
    return noReplayResult(launch, requested);
  }

  if (
    launch.status === "LAUNCHED" ||
    launch.status === "CONFIRMED"
  ) {
    return noReplayResult(launch, requested);
  }

  if (launch.status === "AMBIGUOUS") {
    const error = new Error(
      "MISSION_AUTONOMOUS_START_AMBIGUOUS_NO_REPLAY"
    );

    error.launch = launch;
    throw error;
  }

  if (launch.status !== "PENDING") {
    throw new Error(
      `MISSION_AUTONOMOUS_START_NOT_DISPATCHABLE:${launch.status}`
    );
  }

  const dispatch = await dispatch_launch(control, launch, {
    launch_attempt_id: attemptIdFor(launchId),
    launcher_request_id: requestIdFor(launchId),
    entry_path: entryPath,
    node_path,
    spawn_env,
  });

  if (!dispatch?.launch) {
    throw new Error(
      "MISSION_AUTONOMOUS_START_INVALID_DISPATCH_RECEIPT"
    );
  }

  return {
    status: dispatch.launch.status,
    launch: dispatch.launch,
    receipt: dispatch.receipt ?? dispatch.launch.receipt ?? null,
    request_deduplicated: requested.deduplicated === true,
    dispatched: true,
    replay_blocked: false,
  };
}
