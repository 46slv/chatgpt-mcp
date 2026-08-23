import assert from "node:assert/strict";
import {spawn, spawnSync} from "node:child_process";
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

function createPendingLaunch(control, {goal = "continue mission after crash"} = {}) {
  return requestMissionChildLaunch(control, {
    launch_id: "LAUNCH-CRASH-001",
    idempotency_key: "MISSION-CRASH:launch:001",
    child_run_id: "RUN-CHILD",
    goal,
  }, {boundary: {safe: true}}).launch;
}

async function runCrashHelper(mode) {
  const root = process.env.DEVEXEC_MISSION_CRASH_ROOT;
  if (!root) process.exit(91);

  const control = openMissionControl({
    base: root,
    mission_id: "MISSION-CRASH",
    run_id: "RUN-ROOT",
  });

  if (mode === "during_dispatch_after_spawn") {
    const marker = process.env.DEVEXEC_MISSION_CRASH_MARKER;
    if (!marker) process.exit(92);
    const ready = process.env.DEVEXEC_MISSION_CRASH_READY;
    if (!ready) process.exit(96);
    const childEntry = path.join(root, "child-side-effect.mjs");
    fs.writeFileSync(childEntry, [
      'import fs from "node:fs";',
      'fs.appendFileSync(process.argv[2], "child-once\\n");',
    ].join("\n") + "\n", "utf8");
    const launch = createPendingLaunch(control, {goal: marker});

    await dispatchMissionChildLaunch(control, launch, {
      launch_attempt_id: "ATTEMPT-CRASH-001",
      launcher_request_id: "REQ-CRASH-001",
      entry_path: childEntry,
      spawn_impl: (command, args, options) => {
        const child = spawn(command, args, options);
        // Register before dispatchMissionChildLaunch installs its own spawn
        // observer. READY therefore proves a real child has spawned after
        // durable LAUNCHING but before the launcher can persist its receipt.
        child.once("spawn", () => {
          fs.writeFileSync(ready, "READY\n", "utf8");
          while (true) {}
        });
        return child;
      },
    });
    process.exit(95);
  }

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
    process.exit(74);
  }

  process.exit(94);
}

if (helperMode) {
  await runCrashHelper(helperMode);
} else {
  function withRoot(fn) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-process-hard-termination-"));
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

  async function waitForText(file, expected, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === expected) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null, expected);
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

  test("external hard termination after durable LAUNCHING and real child spawn before receipt never replays the child", () => withRoot(async root => {
    const marker = path.join(root, "dispatcher-child-side-effect.txt");
    const ready = path.join(root, "external-hard-termination.ready");
    const helper = spawn(process.execPath, [self], {
      env: {
        ...process.env,
        DEVEXEC_MISSION_CRASH_HELPER: "during_dispatch_after_spawn",
        DEVEXEC_MISSION_CRASH_ROOT: root,
        DEVEXEC_MISSION_CRASH_MARKER: marker,
        DEVEXEC_MISSION_CRASH_READY: ready,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const deadline = Date.now() + 10000;
    while (!fs.existsSync(ready) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(
      fs.existsSync(ready),
      true,
      "helper never reached the post-LAUNCHING/pre-receipt real-spawn boundary",
    );

    const terminated = helper.kill();
    assert.equal(terminated, true, "external controller could not terminate the helper process");

    const terminatedResult = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("terminated helper did not exit")),
        10000,
      );
      helper.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({code, signal});
      });
      helper.once("error", reject);
    });
    assert.equal(
      terminatedResult.code === 0,
      false,
      "externally terminated helper unexpectedly exited cleanly",
    );

    await waitForText(marker, "child-once\n");

    const launch = await assertRestartCannotRespawn(root);
    assert.equal(launch.status, "LAUNCHING");
    assert.equal(launch.receipt, null);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(fs.readFileSync(marker, "utf8"), "child-once\n");
  }));
}
