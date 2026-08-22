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

function controlFor(base = tempBase()) {
  return openMissionControl({base, mission_id: "MISSION-TARGET-VALIDATION", run_id: "RUN-ROOT"});
}

function request(control, target_alias) {
  return requestMissionChildLaunch(control, {
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
}

for (const [label, value] of [
  ["blank", "   "],
  ["non-string", {bad: true}],
]) {
  test(`${label} target alias is rejected before durable PENDING state is created`, () => {
    const control = controlFor();
    assert.throws(() => request(control, value), /MISSION_LAUNCH_TARGET_ALIAS_INVALID/);
    assert.deepEqual(readMissionLaunchState(control).launches, []);
  });

  test(`legacy malformed ${label} target is rejected before PENDING -> LAUNCHING`, async () => {
    const control = controlFor();
    const requested = request(control, "valid-target");
    const file = path.join(control.paths.root, "launch-state.json");
    const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
    persisted.launches[0].target_alias = value;
    fs.writeFileSync(file, JSON.stringify(persisted, null, 2) + "\n", "utf8");

    let spawnCalls = 0;
    await assert.rejects(
      () => dispatchMissionChildLaunch(control, requested.launch, {
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
    const after = readMissionLaunchState(control).launches[0];
    assert.equal(after.status, "PENDING");
    assert.equal(after.launch_attempt_id, null);
    assert.equal(after.launcher_request_id, null);
  });
}

test("target alias is canonicalized before it becomes durable launch state", () => {
  const control = controlFor();
  const requested = request(control, "  child-target  ");
  assert.equal(requested.launch.target_alias, "child-target");
  assert.equal(readMissionLaunchState(control).launches[0].target_alias, "child-target");
});

test("idempotency compares canonical target aliases instead of transport whitespace", () => {
  const control = controlFor();
  const first = request(control, "  child-target  ");
  assert.equal(first.deduplicated, false);
  const replay = request(control, "child-target");
  assert.equal(replay.deduplicated, true);
  assert.equal(replay.launch.target_alias, "child-target");
  assert.throws(() => request(control, "different-target"), /LAUNCH_IDEMPOTENCY_KEY_CONFLICT/);
});

test("valid target alias still reaches the launch side-effect boundary", async () => {
  const control = controlFor();
  const requested = request(control, "child-target");
  const error = await dispatchMissionChildLaunch(control, requested.launch, {
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
