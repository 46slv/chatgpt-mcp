import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {durableWriteJsonAtomic} from "./devexec-durable-write.mjs";
import {withMissionLock} from "./devexec-mission-lock.mjs";
import {loadMissionState} from "./devexec-mission-state.mjs";
import {normalizeDurableTargetAlias} from "./devexec-target-alias.mjs";

const ACTIVE = new Set(["PENDING", "LAUNCHING", "LAUNCHED", "AMBIGUOUS"]);

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} required`);
  return value.trim();
}

function normalizeConstraints(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("constraints must be an array");
  return value.map((item, index) => required(item, `constraints[${index}]`));
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

function refreshControlState(control, {require_bound = true} = {}) {
  const state = loadMissionState(control.paths.state_file);
  if (state.mission_id !== control.state.mission_id) throw new Error("MISSION_STATE_ID_MISMATCH");
  const boundRunId = control.bound_run_id ?? control.state.current_run_id;
  if (require_bound && state.current_run_id !== boundRunId) throw new Error("STALE_MISSION_CONTROL");
  control.state = state;
  return state;
}

function withLaunchStateLock(control, fn, options = {}) {
  return withMissionLock(control.paths.root, () => {
    refreshControlState(control, options);
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
  durableWriteJsonAtomic(file, state);
}

function semanticRequest(control, input) {
  return {
    parent_run_id: input.parent_run_id ?? control.state.current_run_id,
    child_run_id: input.child_run_id,
    goal: input.goal,
    constraints: normalizeConstraints(input.constraints),
    target_alias: normalizeDurableTargetAlias(input.target_alias),
  };
}

function sameRequest(control, existing, input) {
  return JSON.stringify(stable({
    parent_run_id: existing.parent_run_id,
    child_run_id: existing.child_run_id,
    goal: existing.goal,
    constraints: existing.constraints ?? [],
    target_alias: normalizeDurableTargetAlias(existing.target_alias ?? null),
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
    const constraints = normalizeConstraints(input?.constraints);
    const targetAlias = normalizeDurableTargetAlias(input?.target_alias);
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
      constraints,
      target_alias: targetAlias,
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
  dispatch_preflight = null,
  preflight = undefined,
} = {}) {
  // Normalize all caller-controlled preflight input before acquiring the Mission
  // lock. Even a nominally declarative object can carry accessors/Proxy traps;
  // property access under the lock would reintroduce caller-code execution in
  // the atomic section. Only plain primitive strings cross the lock boundary.
  if (preflight !== undefined) throw new Error("MISSION_LAUNCH_CALLBACK_PREFLIGHT_FORBIDDEN");
  let normalizedDispatchPreflight = null;
  if (dispatch_preflight != null) {
    if (typeof dispatch_preflight !== "object" || Array.isArray(dispatch_preflight)) {
      throw new Error("MISSION_LAUNCH_DISPATCH_PREFLIGHT_INVALID");
    }
    normalizedDispatchPreflight = {
      entry_path: required(dispatch_preflight.entry_path, "entry_path"),
      node_path: required(dispatch_preflight.node_path ?? process.execPath, "node_path"),
    };
  }

  return withLaunchStateLock(control, () => {
    const state = loadLaunchState(control);
    const launch = state.launches.find(item => item.launch_id === launchId);
    if (!launch) throw new Error("launch not found");
    const attemptId = required(launch_attempt_id, "launch_attempt_id");
    const launcherRequestId = required(launcher_request_id, "launcher_request_id");
    if (launch.status === "LAUNCHING") {
      if (launch.launch_attempt_id === attemptId && launch.launcher_request_id === launcherRequestId) {
        return {state, launch, deduplicated: true, preflight: null};
      }
      throw new Error("MISSION_LAUNCH_IN_FLIGHT");
    }
    if (launch.status !== "PENDING") throw new Error(`launch not pending: ${launch.status}`);

    // The module itself performs deterministic spec construction against this
    // exact durable snapshot immediately before PENDING -> LAUNCHING. No caller
    // function/property access occurs while the Mission lock is held.
    const preflightResult = normalizedDispatchPreflight == null
      ? null
      : buildMissionChildLaunchSpec(control, clone(launch), normalizedDispatchPreflight);

    launch.status = "LAUNCHING";
    launch.launch_attempt_id = attemptId;
    launch.launcher_request_id = launcherRequestId;
    launch.lease_token = required(lease_token, "lease_token");
    launch.lease_until = new Date(Date.parse(now) + lease_ms).toISOString();
    state.revision += 1;
    saveLaunchState(control, state);
    return {state, launch, deduplicated: false, preflight: preflightResult};
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
    if (!receipt || typeof receipt !== "object") throw new Error("launch receipt required");
    if (launch.status === "LAUNCHED") {
      if (launch.launch_attempt_id === attemptId) return {state, launch, deduplicated: true};
      throw new Error("MISSION_LAUNCH_ATTEMPT_MISMATCH");
    }
    if (launch.status === "CONFIRMED") {
      if (launch.launch_attempt_id !== attemptId) throw new Error("MISSION_LAUNCH_ATTEMPT_MISMATCH");
      if (launch.receipt) return {state, launch, deduplicated: true};
      launch.launched_at = launch.launched_at ?? now;
      launch.receipt = clone(receipt);
      state.revision += 1;
      saveLaunchState(control, state);
      return {state, launch, deduplicated: false};
    }
    if (launch.status !== "LAUNCHING") throw new Error(`launch not launching: ${launch.status}`);
    if (launch.launch_attempt_id !== attemptId) throw new Error("MISSION_LAUNCH_ATTEMPT_MISMATCH");
    launch.status = "LAUNCHED";
    launch.launched_at = now;
    launch.receipt = clone(receipt);
    state.revision += 1;
    saveLaunchState(control, state);
    return {state, launch, deduplicated: false};
  }, {require_bound: false});
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
  }, {require_bound: false});
}

export function reconcileMissionChildLaunches(control, {
  now = new Date().toISOString(),
} = {}) {
  return withLaunchStateLock(control, () => {
    const state = loadLaunchState(control);
    let changed = false;
    for (const launch of state.launches) {
      if (!["LAUNCHING", "LAUNCHED"].includes(launch.status)) continue;
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
  if (!launch) throw new Error("launch required");
  const missionId = required(launch.mission_id, "launch.mission_id");
  if (missionId !== control.state.mission_id) throw new Error("launch/control mission mismatch");
  if (!["PENDING", "LAUNCHING"].includes(launch.status)) throw new Error("launch not dispatchable");
  const parentRunId = required(launch.parent_run_id, "launch.parent_run_id");
  if (parentRunId !== control.state.current_run_id) throw new Error("STALE_PARENT_RUN_ID");
  const childRunId = required(launch.child_run_id, "launch.child_run_id");
  if (control.state.runs.some(run => run.run_id === childRunId)) throw new Error("CHILD_RUN_ID_ALREADY_EXISTS");
  const goal = required(launch.goal, "launch.goal");
  const constraints = normalizeConstraints(launch.constraints);
  const targetAlias = normalizeDurableTargetAlias(launch.target_alias);
  return {
    command: required(node_path, "node_path"),
    args: [required(entry_path, "entry_path"), goal],
    env: {
      DEV_EXEC_MISSION_ID: missionId,
      DEV_EXEC_PARENT_RUN_ID: parentRunId,
      DEV_EXEC_RUN_ID: childRunId,
      // Always write these inherited-control keys, including explicit empty
      // values, so ambient state from the parent process cannot leak into an
      // unrelated child continuation.
      DEV_EXEC_MISSION_CONSTRAINTS_JSON: JSON.stringify(constraints),
      DEV_EXEC_TARGET_ALIAS: targetAlias ?? "",
    },
  };
}

export function readMissionLaunchState(control) {
  return withLaunchStateLock(control, () => clone(loadLaunchState(control)), {require_bound: false});
}
