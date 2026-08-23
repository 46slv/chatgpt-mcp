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

function corruptLaunch(control, field, value) {
  const file = path.join(control.paths.root, "launch-state.json");
  const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
  persisted.launches[0][field] = value;
  fs.writeFileSync(file, JSON.stringify(persisted, null, 2) + "\n", "utf8");
}

function assertPendingWithoutAttempt(control) {
  const after = readMissionLaunchState(control).launches[0];
  assert.equal(after.status, "PENDING");
  assert.equal(after.launch_attempt_id, null);
  assert.equal(after.launcher_request_id, null);
  assert.equal(after.lease_token, null);
  assert.equal(after.lease_until, null);
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
    corruptLaunch(control, "target_alias", value);

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
    assertPendingWithoutAttempt(control);
  });
}

test("durable constraints corruption is rejected before PENDING -> LAUNCHING", async () => {
  const control = controlFor();
  const requested = request(control, "valid-target");
  corruptLaunch(control, "constraints", "corrupt");

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
    /constraints must be an array/,
  );
  assert.equal(spawnCalls, 0);
  assertPendingWithoutAttempt(control);
});

for (const [field, value, expected] of [
  ["goal", "   ", /launch\.goal required/],
  ["parent_run_id", "", /launch\.parent_run_id required/],
  ["child_run_id", null, /launch\.child_run_id required/],
  ["parent_run_id", "RUN-OTHER", /STALE_PARENT_RUN_ID/],
  ["child_run_id", "RUN-ROOT", /CHILD_RUN_ID_ALREADY_EXISTS/],
]) {
  test(`durable ${field}=${JSON.stringify(value)} corruption is rejected before PENDING -> LAUNCHING`, async () => {
    const control = controlFor();
    const requested = request(control, "valid-target");
    corruptLaunch(control, field, value);

    let spawnCalls = 0;
    await assert.rejects(
      () => dispatchMissionChildLaunch(control, requested.launch, {
        launch_attempt_id: "ATTEMPT-IDENTITY",
        launcher_request_id: "REQUEST-IDENTITY",
        entry_path: "devexec-goal.mjs",
        node_path: "node",
        spawn_impl: () => {
          spawnCalls += 1;
          throw new Error("spawn must not be reached");
        },
      }),
      expected,
    );
    assert.equal(spawnCalls, 0);
    assertPendingWithoutAttempt(control);
  });
}

test("invalid launch entry path is rejected before PENDING -> LAUNCHING", async () => {
  const control = controlFor();
  const requested = request(control, "valid-target");

  let spawnCalls = 0;
  await assert.rejects(
    () => dispatchMissionChildLaunch(control, requested.launch, {
      launch_attempt_id: "ATTEMPT-1",
      launcher_request_id: "REQUEST-1",
      entry_path: "   ",
      node_path: "node",
      spawn_impl: () => {
        spawnCalls += 1;
        throw new Error("spawn must not be reached");
      },
    }),
    /entry_path required/,
  );
  assert.equal(spawnCalls, 0);
  assertPendingWithoutAttempt(control);
});

test("declarative dispatch preflight validates the durable snapshot before launch metadata is persisted", () => {
  const control = controlFor();
  request(control, "valid-target");
  corruptLaunch(control, "constraints", "corrupt");

  assert.throws(() => beginMissionChildLaunch(control, "LAUNCH-1", {
    launch_attempt_id: "ATTEMPT-ATOMIC",
    launcher_request_id: "REQUEST-ATOMIC",
    dispatch_preflight: {
      entry_path: "devexec-goal.mjs",
      node_path: "node",
    },
  }), /constraints must be an array/);

  assertPendingWithoutAttempt(control);
});

test("begin rejects legacy synchronous callback preflight before invoking it or transitioning", () => {
  const control = controlFor();
  request(control, "valid-target");
  let preflightCalls = 0;
  assert.throws(() => beginMissionChildLaunch(control, "LAUNCH-1", {
    launch_attempt_id: "ATTEMPT-UNTRUSTED",
    launcher_request_id: "REQUEST-UNTRUSTED",
    preflight: () => {
      preflightCalls += 1;
      return {ok: true};
    },
  }), /MISSION_LAUNCH_CALLBACK_PREFLIGHT_FORBIDDEN/);
  assert.equal(preflightCalls, 0);
  assertPendingWithoutAttempt(control);
});

test("begin rejects legacy async callback preflight before invoking it or transitioning", () => {
  const control = controlFor();
  request(control, "valid-target");
  let preflightCalls = 0;
  assert.throws(() => beginMissionChildLaunch(control, "LAUNCH-1", {
    launch_attempt_id: "ATTEMPT-ASYNC",
    launcher_request_id: "REQUEST-ASYNC",
    preflight: async () => {
      preflightCalls += 1;
      return {ok: true};
    },
  }), /MISSION_LAUNCH_CALLBACK_PREFLIGHT_FORBIDDEN/);
  assert.equal(preflightCalls, 0);
  assertPendingWithoutAttempt(control);
});

test("invalid declarative dispatch preflight is rejected before transition", () => {
  const control = controlFor();
  request(control, "valid-target");
  assert.throws(() => beginMissionChildLaunch(control, "LAUNCH-1", {
    launch_attempt_id: "ATTEMPT-BAD-DESCRIPTOR",
    launcher_request_id: "REQUEST-BAD-DESCRIPTOR",
    dispatch_preflight: () => ({bad: true}),
  }), /MISSION_LAUNCH_DISPATCH_PREFLIGHT_INVALID/);
  assertPendingWithoutAttempt(control);
});

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
