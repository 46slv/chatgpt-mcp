import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

import {openMissionControl} from "./devexec-mission-control.mjs";
import {
  beginMissionChildLaunch,
  readMissionLaunchState,
  requestMissionChildLaunch,
} from "./devexec-mission-launch.mjs";
import {dispatchMissionChildLaunch} from "./devexec-mission-launcher.mjs";

const self = fileURLToPath(import.meta.url);
const helperMode = process.env.DEVEXEC_MISSION_CRASH_HELPER ?? "";

function createPendingLaunch(control) {
  return requestMissionChildLaunch(control, {
    launch_id: "LAUNCH-CRASH-001",
    idempotency_key: "MISSION-CRASH:launch:001",
    child_run_id: "RUN-CHILD",
    goal: "continue mission after crash",
  }, {boundary: {safe: true}}).launch;
}

function runCrashHelper(mode) {
  const root = process.env.DEVEXEC_MISSION_CRASH_ROOT;
  if (!root) process.exit(91);

  const control = openMissionControl({
    base: root,
    mission_id: "MISSION-CRASH",
    run_id: "RUN-ROOT",
  });
  const launch = createPendingLaunch(control);
  beginMissionChildLaunch(control, launch.launch_id, {
    launch_attempt_id: "ATTEMPT-CRASH-001",
    launcher_request_id: "REQ-CRASH-001",
    lease_token: "LEASE-CRASH-001",
  });

  if (mode === "after_begin") process.exit(73);

  if (mode === "after_child_side_effect") {
    const marker = process.env.DEVEXEC_MISSION_CRASH_MARKER;
    if (!marker) process.exit(92);
    const child = spawnSync(process.execPath, [
      "-e",
      `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "child-once\\n")`,
    ], {stdio: "ignore"});
    if (child.status !== 0) process.exit(93);
    // Deliberately exit without a durable launch receipt. This models the
    // ambiguous crash window after a child-side effect may have occurred.
    process.exit(74);
  }

  process.exit(94);
}

if (helperMode) {
  runCrashHelper(helperMode);
} else {
  function withRoot(fn) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-process-crash-"));
    return Promise.resolve(fn(root)).finally(() => fs.rmSync(root, {recursive: true, force: true}));
  }

  function runHelper(root, mode, extraEnv = {}) {
    return spawnSync(process.execPath, [self], {
      encoding: "utf8",
      env: {
        ...process.env,
        DEVEXEC_MISSION_CRASH_HELPER: mode,
        DEVEXEC_MISSION_CRASH_ROOT: root,
        ...extraEnv,
      },
    });
  }

  async function assertRestartCannotRespawn(root) {
    const control = openMissionControl({
      base: root,
      mission_id: "MISSION-CRASH",
      run_id: "RUN-ROOT",
    });
    const launch = readMissionLaunchState(control).launches[0];
    assert.equal(launch.status, "LAUNCHING");
    assert.equal(launch.launch_attempt_id, "ATTEMPT-CRASH-001");
    assert.equal(launch.launcher_request_id, "REQ-CRASH-001");

    let spawnCount = 0;
    await assert.rejects(
      dispatchMissionChildLaunch(control, launch, {
        launch_attempt_id: "ATTEMPT-CRASH-001",
        launcher_request_id: "REQ-CRASH-001",
        entry_path: self,
        spawn_impl: () => {
          spawnCount += 1;
          throw new Error("restart must not spawn");
        },
      }),
      /MISSION_LAUNCH_DISPATCH_ALREADY_IN_FLIGHT/,
    );
    assert.equal(spawnCount, 0);
    return readMissionLaunchState(control).launches[0];
  }

  test("durable LAUNCHING survives a real process exit and restart never respawns it", () => withRoot(async root => {
    const crashed = runHelper(root, "after_begin");
    assert.equal(crashed.status, 73, crashed.stderr || crashed.stdout);

    const launch = await assertRestartCannotRespawn(root);
    assert.equal(launch.status, "LAUNCHING");
    assert.equal(launch.receipt, null);
  }));

  test("child side effect before receipt remains exactly once after a real process exit", () => withRoot(async root => {
    const marker = path.join(root, "child-side-effect.txt");
    const crashed = runHelper(root, "after_child_side_effect", {
      DEVEXEC_MISSION_CRASH_MARKER: marker,
    });
    assert.equal(crashed.status, 74, crashed.stderr || crashed.stdout);
    assert.equal(fs.readFileSync(marker, "utf8"), "child-once\n");

    const launch = await assertRestartCannotRespawn(root);
    assert.equal(launch.status, "LAUNCHING");
    assert.equal(launch.receipt, null);
    assert.equal(fs.readFileSync(marker, "utf8"), "child-once\n");
  }));
}
