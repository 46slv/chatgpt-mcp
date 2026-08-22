import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {openMissionControl} from "./devexec-mission-control.mjs";
import {
  beginMissionChildLaunch,
  readMissionLaunchState,
  requestMissionChildLaunch,
} from "./devexec-mission-launch.mjs";
import {dispatchMissionChildLaunch} from "./devexec-mission-launcher.mjs";

function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-launch-review-"));
  return Promise.resolve(fn(root)).finally(() => fs.rmSync(root, {recursive: true, force: true}));
}

test("restarted dispatcher never respawns an already durable LAUNCHING attempt", () => withRoot(async root => {
  const control = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  const launch = requestMissionChildLaunch(control, {
    launch_id: "LAUNCH-001",
    idempotency_key: "MISSION-001:launch:001",
    child_run_id: "RUN-002",
    goal: "continue mission",
  }, {boundary: {safe: true}}).launch;

  // Simulate the durable state left by a process crash after begin/possibly-spawn
  // but before a launch receipt could be committed.
  beginMissionChildLaunch(control, launch.launch_id, {
    launch_attempt_id: "ATTEMPT-001",
    launcher_request_id: "REQ-001",
    lease_token: "LEASE-001",
  });

  let spawnCount = 0;
  await assert.rejects(
    dispatchMissionChildLaunch(control, launch, {
      launch_attempt_id: "ATTEMPT-001",
      launcher_request_id: "REQ-001",
      entry_path: "C:/repo/tools/devexec-goal.mjs",
      spawn_impl: () => {
        spawnCount += 1;
        throw new Error("must not spawn");
      },
    }),
    /MISSION_LAUNCH_DISPATCH_ALREADY_IN_FLIGHT/,
  );

  assert.equal(spawnCount, 0);
  const disk = readMissionLaunchState(control).launches[0];
  assert.equal(disk.status, "LAUNCHING");
  assert.equal(disk.launch_attempt_id, "ATTEMPT-001");
  assert.equal(disk.launcher_request_id, "REQ-001");
}));
