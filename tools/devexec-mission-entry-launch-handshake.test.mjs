import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {openMissionControl} from "./devexec-mission-control.mjs";
import {startMissionLocalAgent} from "./devexec-mission-entry-runtime.mjs";
import {
  beginMissionChildLaunch,
  completeMissionChildLaunch,
  readMissionLaunchState,
  requestMissionChildLaunch,
} from "./devexec-mission-launch.mjs";

function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-entry-handshake-"));
  return Promise.resolve(fn(root)).finally(() => fs.rmSync(root, {recursive: true, force: true}));
}

test("active child can confirm LAUNCHING before parent receipt and later receipt never downgrades CONFIRMED", () => withRoot(root => {
  const parent = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  const launch = requestMissionChildLaunch(parent, {
    launch_id: "LAUNCH-001",
    idempotency_key: "MISSION-001:launch:001",
    child_run_id: "RUN-002",
    goal: "continue mission",
  }, {boundary: {safe: true}}).launch;
  beginMissionChildLaunch(parent, launch.launch_id, {
    launch_attempt_id: "ATTEMPT-001",
    launcher_request_id: "REQ-001",
    lease_token: "LEASE-001",
  });

  const child = startMissionLocalAgent({
    base: root,
    identity: {mission_id: "MISSION-001", run_id: "RUN-002", parent_run_id: "RUN-001"},
    start_attempt_id: "START-001",
    start_local_agent: () => ({run_id: "AGENT-002", decision: "COMPLETE"}),
  });
  assert.equal(child.launch_reconciled, true);
  let disk = readMissionLaunchState(child.mission).launches[0];
  assert.equal(disk.status, "CONFIRMED");
  assert.equal(disk.receipt, null);

  const completed = completeMissionChildLaunch(parent, "LAUNCH-001", {
    launch_attempt_id: "ATTEMPT-001",
    receipt: {pid: 4242},
  });
  assert.equal(completed.launch.status, "CONFIRMED");
  disk = readMissionLaunchState(child.mission).launches[0];
  assert.equal(disk.status, "CONFIRMED");
  assert.equal(disk.receipt.pid, 4242);
}));
