import {spawn} from "node:child_process";

import {
  beginMissionChildLaunch,
  buildMissionChildLaunchSpec,
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
  now = new Date().toISOString(),
} = {}) {
  const launchId = required(launch?.launch_id, "launch_id");
  const attemptId = required(launch_attempt_id, "launch_attempt_id");
  const launcherRequestId = required(launcher_request_id, "launcher_request_id");

  const begun = beginMissionChildLaunch(control, launchId, {
    launch_attempt_id: attemptId,
    launcher_request_id: launcherRequestId,
    lease_token,
    lease_ms,
    now,
  });
  if (begun.deduplicated) {
    // A durable LAUNCHING record with the same attempt means a previous dispatcher
    // may already have crossed the spawn side-effect boundary. Re-spawning here
    // would turn an ambiguous restart into a duplicate child RUN.
    throw new Error("MISSION_LAUNCH_DISPATCH_ALREADY_IN_FLIGHT");
  }
  const spec = buildMissionChildLaunchSpec(control, begun.launch, {entry_path, node_path});
  let child;
  try {
    child = spawn_impl(spec.command, spec.args, {
      env: {...process.env, ...spec.env},
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
