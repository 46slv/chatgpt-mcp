import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {openMissionControl} from "./devexec-mission-control.mjs";
import {readMissionLaunchState, requestMissionChildLaunch} from "./devexec-mission-launch.mjs";
import {dispatchMissionChildLaunch} from "./devexec-mission-launcher.mjs";

function tempBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-target-validation-"));
}

function pendingLaunch(target_alias) {
  const base = tempBase();
  const control = openMissionControl({base, mission_id: "MISSION-TARGET-VALIDATION", run_id: "RUN-ROOT"});
  const requested = requestMissionChildLaunch(control, {
    parent_run_id: "RUN-ROOT",
    child_run_id: "RUN-CHILD",
    launch_id: "LAUNCH-1",
    idempotency_key: "target-validation-1",
    goal: "child work",
    constraints: [],
    target_alias,
  }, {
    boundary: {safe: true, pending_action: false, ambiguous_action: false},
  });
  return {base, control, launch: requested.launch};
}

for (const [label, value] of [
  ["blank", "   "],
  ["non-string", {bad: true}],
]) {
  test(`${label} target alias is rejected before PENDING -> LAUNCHING`, async () => {
    const {control, launch} = pendingLaunch(value);
    let spawnCalls = 0;
    await assert.rejects(
      () => dispatchMissionChildLaunch(control, launch, {
        launch_attempt_id: "ATTEMPT-1",
        launcher_request_id: "REQUEST-1",
        entry_path: "devexec-goal.mjs",
        node_path: "node",
        spawn_impl: () => {
          spawnCalls += 1;
          throw new Error("spawn must not be reached");
        },
      }),
      /MISSION_LAUNCH_TARGET_ALIAS_INVALID/,
    );
    assert.equal(spawnCalls, 0);
    const persisted = readMissionLaunchState(control).launches[0];
    assert.equal(persisted.status, "PENDING");
    assert.equal(persisted.launch_attempt_id, null);
    assert.equal(persisted.launcher_request_id, null);
  });
}

test("valid target alias still reaches the launch side-effect boundary", async () => {
  const {control, launch} = pendingLaunch("child-target");
  const error = await dispatchMissionChildLaunch(control, launch, {
    launch_attempt_id: "ATTEMPT-1",
    launcher_request_id: "REQUEST-1",
    entry_path: "devexec-goal.mjs",
    node_path: "node",
    spawn_impl: () => {
      const failure = new Error("synthetic spawn failure");
      failure.code = "SYNTHETIC";
      throw failure;
    },
  }).then(() => null, value => value);
  assert.match(error?.message ?? "", /MISSION_LAUNCH_DISPATCH_AMBIGUOUS/);
  const persisted = readMissionLaunchState(control).launches[0];
  assert.equal(persisted.status, "AMBIGUOUS");
});
