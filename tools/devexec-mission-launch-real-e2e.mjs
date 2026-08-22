#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {openMissionControl} from "./devexec-mission-control.mjs";
import {readMissionLaunchState, reconcileMissionChildLaunches, requestMissionChildLaunch} from "./devexec-mission-launch.mjs";
import {dispatchMissionChildLaunch} from "./devexec-mission-launcher.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-launch-e2e-"));
try {
  const output = path.join(root, "child-env.json");
  const childEntry = path.join(root, "child.mjs");
  fs.writeFileSync(childEntry, [
    'import fs from "node:fs";',
    'const output=process.argv[2];',
    'fs.writeFileSync(output, JSON.stringify({mission_id:process.env.DEV_EXEC_MISSION_ID,parent_run_id:process.env.DEV_EXEC_PARENT_RUN_ID,run_id:process.env.DEV_EXEC_RUN_ID})+"\\n");',
  ].join("\n") + "\n");

  let control = openMissionControl({base: root, mission_id: "MISSION-E2E", run_id: "RUN-ROOT"});
  const launch = requestMissionChildLaunch(control, {
    launch_id: "LAUNCH-E2E",
    idempotency_key: "MISSION-E2E:launch:001",
    child_run_id: "RUN-CHILD",
    goal: output,
  }, {boundary: {safe: true}}).launch;

  const dispatched = await dispatchMissionChildLaunch(control, launch, {
    launch_attempt_id: "ATTEMPT-E2E",
    launcher_request_id: "REQ-E2E",
    entry_path: childEntry,
  });

  const deadline = Date.now() + 5000;
  while (!fs.existsSync(output) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(fs.existsSync(output), "child output was not created");
  const childEnv = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.deepEqual(childEnv, {
    mission_id: "MISSION-E2E",
    parent_run_id: "RUN-ROOT",
    run_id: "RUN-CHILD",
  });

  control = openMissionControl({
    base: root,
    mission_id: "MISSION-E2E",
    run_id: "RUN-CHILD",
    parent_run_id: "RUN-ROOT",
  });
  assert.equal(reconcileMissionChildLaunches(control).changed, true);
  const finalLaunch = readMissionLaunchState(control).launches[0];
  assert.equal(finalLaunch.status, "CONFIRMED");

  process.stdout.write(JSON.stringify({
    status: "PASS",
    pid: dispatched.receipt.pid,
    mission_id: childEnv.mission_id,
    parent_run_id: childEnv.parent_run_id,
    child_run_id: childEnv.run_id,
    launch_status: finalLaunch.status,
  }, null, 2) + "\n");
} finally {
  fs.rmSync(root, {recursive: true, force: true});
}
