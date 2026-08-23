import fs from "node:fs";
import path from "node:path";

import {
  deriveAutonomousStartBoundary,
  parseAutonomousStartArgs,
} from "./devexec-mission-autonomous-start-cli.mjs";

import {
  startMissionRunAutonomously,
} from "./devexec-mission-autonomous-start.mjs";

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} required`);
  }

  return value.trim();
}

function stateDirectory(base, env = process.env) {
  if (typeof base !== "string" || !base.trim()) {
    throw new Error("DEVEXEC_CONTROL_BASE_REQUIRED");
  }

  return (
    env.DEV_EXEC_STATE_DIR ??
    path.join(
      base,
      "ChatGPTMCPProbe",
      "dev-exec-state",
    )
  );
}

export function readDevExecRunState({
  base,
  run_id,
  env = process.env,
} = {}) {
  const runId = required(run_id, "run_id");

  const file = path.join(
    stateDirectory(base, env),
    `${runId}.json`,
  );

  if (!fs.existsSync(file)) {
    throw new Error(
      "DEVEXEC_CONTROL_RUN_STATE_MISSING"
    );
  }

  let state;

  try {
    state = JSON.parse(
      fs.readFileSync(file, "utf8"),
    );
  } catch (error) {
    const wrapped = new Error(
      "DEVEXEC_CONTROL_RUN_STATE_INVALID"
    );

    wrapped.cause = error;
    throw wrapped;
  }

  if (!state || state.run_id !== runId) {
    throw new Error(
      "DEVEXEC_CONTROL_RUN_STATE_MISMATCH"
    );
  }

  return state;
}

export function inspectAutonomousStartCapability({
  base,
  parent_run_id,
  env = process.env,
} = {}) {
  const parentRunId = required(
    parent_run_id,
    "parent_run_id",
  );

  const state = readDevExecRunState({
    base,
    run_id: parentRunId,
    env,
  });

  const boundary =
    deriveAutonomousStartBoundary({
      base,
      parent_run_id: parentRunId,
      env,
    });

  return {
    protocol:
      "devexec.control.autonomous-start-capability",
    schema_version: 1,
    parent_run_id: parentRunId,
    phase: state.phase ?? null,
    boundary,
    can_start:
      boundary.safe === true &&
      boundary.pending_action !== true &&
      boundary.ambiguous_action !== true,
  };
}

export async function startAutonomousRun({
  base,
  mission_id,
  parent_run_id,
  child_run_id,
  goal,
  target_alias = null,
  constraints = [],
  entry_path,
  launch_id = null,
  idempotency_key = null,
  env = process.env,
} = {}, {
  start = startMissionRunAutonomously,
} = {}) {
  const args = [
    "--mission",
    required(mission_id, "mission_id"),

    "--parent-run",
    required(parent_run_id, "parent_run_id"),

    "--child-run",
    required(child_run_id, "child_run_id"),

    "--goal",
    required(goal, "goal"),

    "--entry",
    required(entry_path, "entry_path"),
  ];

  if (target_alias != null) {
    args.push(
      "--target",
      required(target_alias, "target_alias"),
    );
  }

  for (const constraint of constraints ?? []) {
    args.push(
      "--constraint",
      required(constraint, "constraint"),
    );
  }

  if (launch_id != null) {
    args.push(
      "--launch-id",
      required(launch_id, "launch_id"),
    );
  }

  if (idempotency_key != null) {
    args.push(
      "--idempotency-key",
      required(
        idempotency_key,
        "idempotency_key",
      ),
    );
  }

  const parsed = parseAutonomousStartArgs(
    args,
    {env},
  );

  const capability =
    inspectAutonomousStartCapability({
      base,
      parent_run_id:
        parsed.parent_run_id,
      env,
    });

  if (!capability.can_start) {
    if (
      capability.boundary.pending_action === true ||
      capability.boundary.ambiguous_action === true
    ) {
      throw new Error(
        "DEVEXEC_CONTROL_START_BLOCKED_IN_FLIGHT"
      );
    }

    throw new Error(
      "DEVEXEC_CONTROL_START_UNSAFE_BOUNDARY"
    );
  }

  const result = await start({
    base,
    ...parsed,
    boundary: capability.boundary,
  });

  return {
    protocol:
      "devexec.control.autonomous-start-receipt",
    schema_version: 1,

    capability,

    mission_id: parsed.mission_id,
    parent_run_id: parsed.parent_run_id,
    child_run_id: parsed.child_run_id,

    launch_id: parsed.launch_id,
    idempotency_key:
      parsed.idempotency_key,

    target_alias:
      parsed.target_alias,

    constraints:
      parsed.constraints,

    status: result.status,
    dispatched:
      result.dispatched,
    replay_blocked:
      result.replay_blocked,
    request_deduplicated:
      result.request_deduplicated === true,

    launch_receipt:
      result.receipt ??
      result.launch?.receipt ??
      null,
  };
}
