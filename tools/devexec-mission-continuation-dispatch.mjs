import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath, pathToFileURL} from "node:url";

import {openMissionControl} from "./devexec-mission-control.mjs";
import {readMissionLaunchState} from "./devexec-mission-launch.mjs";
import {dispatchMissionChildLaunch} from "./devexec-mission-launcher.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} required`);
  return value.trim();
}

function findLaunch(control, launchId) {
  const state = readMissionLaunchState(control);
  const launch = state.launches.find(item => item.launch_id === launchId) ?? null;
  if (!launch) throw new Error("MISSION_CONTINUATION_LAUNCH_NOT_FOUND");
  return launch;
}

export async function dispatchMissionContinuation({
  base,
  mission_id,
  parent_run_id,
  launch_id,
  entry_path = path.join(HERE, "devexec-goal.mjs"),
  now = new Date().toISOString(),
} = {}, {
  dispatch_impl = dispatchMissionChildLaunch,
} = {}) {
  const missionId = required(mission_id, "mission_id");
  const parentRunId = required(parent_run_id, "parent_run_id");
  const launchId = required(launch_id, "launch_id");
  const control = openMissionControl({base, mission_id: missionId, run_id: parentRunId});
  const launch = findLaunch(control, launchId);

  if (launch.status === "LAUNCHED" || launch.status === "CONFIRMED") {
    return {launch, receipt: launch.receipt ?? null, deduplicated: true};
  }
  if (launch.status !== "PENDING") {
    const error = new Error(`MISSION_CONTINUATION_NOT_DISPATCHABLE:${launch.status}`);
    error.launch = launch;
    throw error;
  }

  const result = await dispatch_impl(control, launch, {
    launch_attempt_id: `${launchId}:attempt-1`,
    launcher_request_id: `${launchId}:request-1`,
    lease_token: `${launchId}:lease-1`,
    entry_path,
    now,
  });
  return {...result, deduplicated: false};
}

export function dispatchMissionContinuationSync(input, {
  spawn_sync = spawnSync,
  cli_path = fileURLToPath(import.meta.url),
} = {}) {
  const payload = Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
  const result = spawn_sync(process.execPath, [cli_path, "--dispatch", payload], {
    encoding: "utf8",
    windowsHide: true,
    env: process.env,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const error = new Error(`MISSION_CONTINUATION_DISPATCH_FAILED:${result.status ?? "NO_STATUS"}`);
    error.stdout = result.stdout || "";
    error.stderr = result.stderr || "";
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse((result.stdout || "").trim());
  } catch (error) {
    const wrapped = new Error("MISSION_CONTINUATION_DISPATCH_INVALID_RESPONSE");
    wrapped.cause = error;
    throw wrapped;
  }
  return parsed;
}

async function main() {
  if (process.argv[2] !== "--dispatch" || !process.argv[3]) {
    throw new Error("usage: devexec-mission-continuation-dispatch.mjs --dispatch <base64url-json>");
  }
  const input = JSON.parse(Buffer.from(process.argv[3], "base64url").toString("utf8"));
  const result = await dispatchMissionContinuation(input);
  process.stdout.write(JSON.stringify({
    launch_id: result.launch.launch_id,
    child_run_id: result.launch.child_run_id,
    status: result.launch.status,
    receipt: result.receipt ?? null,
    deduplicated: result.deduplicated === true,
  }) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(String(error?.stack || error));
    process.exitCode = 2;
  });
}
