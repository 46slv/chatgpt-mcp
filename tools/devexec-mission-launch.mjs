import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {withMissionLock} from "./devexec-mission-lock.mjs";
import {loadMissionState} from "./devexec-mission-state.mjs";

const ACTIVE = new Set(["PENDING", "LAUNCHING", "LAUNCHED", "AMBIGUOUS"]);

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} required`);
  return value.trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}

function launchStateFile(control) {
  return path.join(control.paths.root, "launch-state.json");
}

function createLaunchState(missionId) {
  return {
    protocol: "devexec.mission-launch-state",
    schema_version: 1,
    mission_id: missionId,
    revision: 0,
    launches: [],
  };
}

function refreshBoundControlState(control) {
  const state = loadMissionState(control.paths.state_file);
  if (state.mission_id !== control.state.mission_id) throw new Error("MISSION_STATE_ID_MISMATCH");
  const boundRunId = control.bound_run_id ?? control.state.current_run_id;
  if (state.current_run_id !== boundRunId) throw new Error("STALE_MISSION_CONTROL");
  control.state = state;
  return state;
}

function withLaunchStateLock(control, fn) {
  return withMissionLock(control.paths.root, () => {
    refreshBoundControlState(control);
    return fn();
  });
}

function loadLaunchState(control) {
  const file = launchStateFile(control);
  if (!fs.existsSync(file)) return createLaunchState(control.state.mission_id);
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  if (state?.protocol !== "devexec.mission-launch-state" || state.schema_version !== 1) {
    throw new Error("invalid mission launch state");
  }
  if (state.mission_id !== control.state.mission_id) throw new Error("MISSION_LAUNCH_ID_MISMATCH");
  if (!Array.isArray(state.launches)) throw new Error("invalid mission launches");
  return state;
}

function saveLaunchState(control, state) {
  const file = launchStateFile(control);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", "utf8");
  fs.renameSync(temp, file);
}

function semanticRequest(control, input) {
  return {
    parent_run_id: input.parent_run_id ?? control.state.current_run_id,
    child_run_id: input.child_run_id,
    goal: input.goal,
    target_alias: input.target_alias ?? null,
  };
}

function sameRequest(control, existing, input) {
  return JSON.stringify(stable({
    parent_run_id: existing.parent_run_id,
    child_run_id: existing.child_run_id,
    goal: existing.goal,
    target_alias: existing.target_alias,
  })) === JSON.stringify(stable(semanticRequest(control, input)));
}

function assertSafeBoundary(boundary) {
  if (boundary?.safe !== true) throw new Error("MISSION_LAUNCH_UNSAFE_BOUNDARY");
  if (boundary.pending_action === true || boundary.ambiguous_action === true) {
    throw new Error("MISSION_LAUNCH_BLOCKED_BY_IN_FLIGHT_ACTION");
  }
}

export function requestMissionChildLaunch(control, input, {
  boundary = {},
  now = new Date().toISOString(),
} = {}) {
  if (!control?.state?.mission_id) throw new Error("mission control required");
  return withLaunchStateLock(control, () => {
    assertSafeBoundary(boundary);
    const parentRunId = required(input?.parent_run_id ?? control.state.current_run_id, "parent_run_id");
    if (parentRunId !== control.state.current_run_id) throw new Error("STALE_PARENT_RUN_ID");
    const childRunId = required(input?.child_run_id, "child_run_id");
    if (control.state.runs.some(run => run.run_id === childRunId)) throw new Error("CHILD_RUN_ID_ALREADY_EXISTS");
    const idempotencyKey = required(input?.idempotency_key, "idempotency_key");
    const goal = required(input?.goal, "goal");
    const launchId = required(input?.launch_id, "launch_id");

    const state = loadLaunchState(control);
    const existingKey = state.launches.find(item => item.idempotency_key === idempotencyKey);
    if (existingKey) {
      if (!sameRequest(control, existingKey, input)) throw new Error("LAUNCH_IDEMPOTENCY_KEY_CONFLICT");
      return {state, launch: existingKey, deduplicated: true};
    }
    if (state.launches.some(item => item.launch_id === launchId)) throw new Error("duplicate launch_id");
    const active = state.launches.find(item => ACTIVE.has(item.status));
    if (active) throw new Error(`MISSION_LAUNCH_ACTIVE:${active.launch_id}`);

    const launch = {
      launch_id: launchId,
      idempotency_key: idempotencyKey,
      mission_id: control.state.mission_id,
      parent_run_id: parentRunId,
      child_run_id: childRunId,
      goal,
      target_alias: input.target_alias ?? null,
      status: "PENDING",
      requested_at: now,
      launch_attempt_id: null,
      launcher_request_id: null,
      lease_token: null,
      lease_until: null,
      launched_at: null,
      confirmed_at: null,
      receipt: null,
    };
    state.launches.push(launch);
    state.revision += 1;
    saveLaunchState(control, state);
    return {state, launch, deduplicated: false};
  });
}

export function beginMissionChildLaunch(control, launchId, {
  launch_attempt_id,
  launcher_request_id,
  lease_token = crypto.randomUUID(),
  lease_ms = 120000,
  now = new Date().toISOString(),
} = {}) {
  return withLaunchStateLock(control, () => {
    const state = loadLaunchState(control);
    const launch = state.launches.find(item => item.launch_id === launchId);
    if (!launch) throw new Error("launch not found");
    const attemptId = required(launch_attempt_id, "launch_attempt_id");
    const launcherRequestId = required(launcher_request_id, "launcher_request_id");
    if (launch.status === "LAUNCHING") {
      if (launch.launch_attempt_id === attemptId && launch.launcher_request_id === launcherRequestId) {
        return {state, launch, deduplicated: true};
      }
      throw new Error("MISSION_LAUNCH_IN_FLIGHT");
    }
    if (launch.status !== "PENDING") throw new Error(`launch not pending: ${launch.status}`);
    launch.status = "LAUNCHING";
    launch.launch_attempt_id = attemptId;
    launch.launcher_request_id = launcherRequestId;
    launch.lease_token = required(lease_token, "lease_token");
    launch.lease_until = new Date(Date.parse(now) + lease_ms).toISOString();
    state.revision += 1;
    saveLaunchState(control, state);
    return {state, launch, deduplicated: false};
  });
}

export function completeMissionChildLaunch(control, launchId, {
  launch_attempt_id,
  receipt,
  now = new Date().toISOString(),
} = {}) {
  return withLaunchStateLock(control, () => {
    const state = loadLaunchState(control);
    const launch = state.launches.find(item => item.launch_id === launchId);
    if (!launch) throw new Error("launch not found");
    const attemptId = required(launch_attempt_id, "launch_attempt_id");
    if (launch.status === "LAUNCHED") {
      if (launch.launch_attempt_id === attemptId) return {state, launch, deduplicated: true};
      throw new Error("MISSION_LAUNCH_ATTEMPT_MISMATCH");
    }
    if (launch.status !== "LAUNCHING") throw new Error(`launch not launching: ${launch.status}`);
    if (launch.launch_attempt_id !== attemptId) throw new Error("MISSION_LAUNCH_ATTEMPT_MISMATCH");
    if (!receipt || typeof receipt !== "object") throw new Error("launch receipt required");
    launch.status = "LAUNCHED";
    launch.launched_at = now;
    launch.receipt = clone(receipt);
    state.revision += 1;
    saveLaunchState(control, state);
    return {state, launch, deduplicated: false};
  });
}

export function markMissionChildLaunchAmbiguous(control, launchId, {
  launch_attempt_id,
  reason,
} = {}) {
  return withLaunchStateLock(control, () => {
    const state = loadLaunchState(control);
    const launch = state.launches.find(item => item.launch_id === launchId);
    if (!launch) throw new Error("launch not found");
    const attemptId = required(launch_attempt_id, "launch_attempt_id");
    if (launch.status !== "LAUNCHING" || launch.launch_attempt_id !== attemptId) {
      throw new Error("MISSION_LAUNCH_ATTEMPT_MISMATCH");
    }
    launch.status = "AMBIGUOUS";
    launch.receipt = {ambiguous: true, reason: required(reason, "reason")};
    state.revision += 1;
    saveLaunchState(control, state);
    return {state, launch};
  });
}

export function reconcileMissionChildLaunches(control, {
  now = new Date().toISOString(),
} = {}) {
  return withLaunchStateLock(control, () => {
    const state = loadLaunchState(control);
    let changed = false;
    for (const launch of state.launches) {
      if (launch.status !== "LAUNCHED") continue;
      const attached = control.state.runs.find(run => run.run_id === launch.child_run_id);
      if (!attached) continue;
      if (attached.parent_run_id !== launch.parent_run_id) throw new Error("RUN_LINEAGE_CONFLICT");
      if (control.state.current_run_id !== launch.child_run_id) continue;
      launch.status = "CONFIRMED";
      launch.confirmed_at = now;
      changed = true;
    }
    if (changed) {
      state.revision += 1;
      saveLaunchState(control, state);
    }
    return {state, changed};
  });
}

export function buildMissionChildLaunchSpec(control, launch, {
  node_path = process.execPath,
  entry_path,
} = {}) {
  if (!launch || launch.mission_id !== control.state.mission_id) throw new Error("launch/control mission mismatch");
  if (!["PENDING", "LAUNCHING"].includes(launch.status)) throw new Error("launch not dispatchable");
  return {
    command: required(node_path, "node_path"),
    args: [required(entry_path, "entry_path"), launch.goal],
    env: {
      DEV_EXEC_MISSION_ID: launch.mission_id,
      DEV_EXEC_PARENT_RUN_ID: launch.parent_run_id,
      DEV_EXEC_RUN_ID: launch.child_run_id,
      ...(launch.target_alias ? {DEV_EXEC_TARGET_ALIAS: launch.target_alias} : {}),
    },
  };
}

export function readMissionLaunchState(control) {
  return withLaunchStateLock(control, () => clone(loadLaunchState(control)));
}
