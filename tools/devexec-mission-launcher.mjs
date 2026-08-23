import {spawn} from "node:child_process";

import {
  beginMissionChildLaunch,
  completeMissionChildLaunch,
  markMissionChildLaunchAmbiguous,
} from "./devexec-mission-launch.mjs";

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} required`);
  return value.trim();
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onSpawn = () => {
      if (settled) return;
      settled = true;
      child.off?.("error", onError);
      resolve();
    };
    const onError = error => {
      if (settled) return;
      settled = true;
      child.off?.("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

export async function dispatchMissionChildLaunch(control, launch, {
  launch_attempt_id,
  launcher_request_id,
  entry_path,
  node_path = process.execPath,
  lease_token,
  lease_ms,
  spawn_impl = spawn,
  spawn_env = process.env,
  now = new Date().toISOString(),
} = {}) {
  const launchId = required(launch?.launch_id, "launch_id");
  const attemptId = required(launch_attempt_id, "launch_attempt_id");
  const launcherRequestId = required(launcher_request_id, "launcher_request_id");

  // Deterministic spec validation and PENDING -> LAUNCHING use the same
  // durable snapshot under the same Mission lock. Only declarative entry/node
  // inputs cross this boundary; no caller code executes inside the lock.
  const begun = beginMissionChildLaunch(control, launchId, {
    launch_attempt_id: attemptId,
    launcher_request_id: launcherRequestId,
    lease_token,
    lease_ms,
    now,
    dispatch_preflight: {entry_path, node_path},
  });
  if (begun.deduplicated) {
    // A durable LAUNCHING record with the same attempt means a previous dispatcher
    // may already have crossed the spawn side-effect boundary. Re-spawning here
    // would turn an ambiguous restart into a duplicate child RUN.
    throw new Error("MISSION_LAUNCH_DISPATCH_ALREADY_IN_FLIGHT");
  }
  const spec = begun.preflight;
  if (!spec) throw new Error("MISSION_LAUNCH_PREFLIGHT_RESULT_MISSING");
  const childEnv = {...spawn_env, ...spec.env};
  // target_alias:null is an explicit request to use normal/default routing for
  // this child. Because spawn_env may be inherited from a targeted parent,
  // omitting the variable would silently reintroduce the parent's target. Clear
  // it unless the durable launch spec intentionally carries an alias.
  if (!Object.prototype.hasOwnProperty.call(spec.env, "DEV_EXEC_TARGET_ALIAS")) {
    delete childEnv.DEV_EXEC_TARGET_ALIAS;
  }
  let child;
  try {
    child = spawn_impl(spec.command, spec.args, {
      env: childEnv,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      shell: false,
    });
    await waitForSpawn(child);
  } catch (error) {
    markMissionChildLaunchAmbiguous(control, launchId, {
      launch_attempt_id: attemptId,
      reason: `SPAWN_ERROR:${error?.code || error?.message || String(error)}`,
    });
    const wrapped = new Error("MISSION_LAUNCH_DISPATCH_AMBIGUOUS");
    wrapped.cause = error;
    throw wrapped;
  }

  const receipt = {
    protocol: "devexec.mission-launch-receipt",
    schema_version: 1,
    mission_id: begun.launch.mission_id,
    parent_run_id: begun.launch.parent_run_id,
    child_run_id: begun.launch.child_run_id,
    launch_id: launchId,
    launch_attempt_id: attemptId,
    launcher_request_id: launcherRequestId,
    pid: Number.isInteger(child.pid) ? child.pid : null,
    spawned_at: now,
  };
  const completed = completeMissionChildLaunch(control, launchId, {
    launch_attempt_id: attemptId,
    receipt,
    now,
  });
  child.unref?.();
  return {launch: completed.launch, receipt, spec};
}
