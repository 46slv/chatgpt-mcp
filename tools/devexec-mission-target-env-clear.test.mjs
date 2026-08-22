import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {openMissionControl} from "./devexec-mission-control.mjs";
import {requestMissionChildLaunch} from "./devexec-mission-launch.mjs";
import {dispatchMissionChildLaunch} from "./devexec-mission-launcher.mjs";

function tempBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-target-env-clear-"));
}

function fakeSpawn(capture) {
  return (command, args, options) => {
    capture.command = command;
    capture.args = args;
    capture.options = options;
    const child = new EventEmitter();
    child.pid = 4242;
    child.unref = () => {};
    setImmediate(() => child.emit("spawn"));
    return child;
  };
}

async function dispatch({target_alias = null, spawn_env = {}} = {}) {
  const base = tempBase();
  const control = openMissionControl({base, mission_id: "MISSION-TARGET-CLEAR", run_id: "RUN-ROOT"});
  const requested = requestMissionChildLaunch(control, {
    parent_run_id: "RUN-ROOT",
    child_run_id: "RUN-CHILD",
    launch_id: "LAUNCH-1",
    idempotency_key: "target-clear-1",
    goal: "child work",
    constraints: [],
    target_alias,
  }, {
    boundary: {safe: true, pending_action: false, ambiguous_action: false},
  });
  const capture = {};
  const result = await dispatchMissionChildLaunch(control, requested.launch, {
    launch_attempt_id: "ATTEMPT-1",
    launcher_request_id: "REQUEST-1",
    entry_path: "devexec-goal.mjs",
    node_path: "node",
    spawn_impl: fakeSpawn(capture),
    spawn_env,
    now: "2026-08-23T00:00:00.000Z",
  });
  return {capture, result};
}

test("untargeted child clears inherited parent target alias", async () => {
  const {capture, result} = await dispatch({
    target_alias: null,
    spawn_env: {
      DEV_EXEC_TARGET_ALIAS: "parent-only-target",
      DEV_EXEC_MISSION_CONSTRAINTS_JSON: JSON.stringify(["parent-only constraint"]),
      KEEP_ME: "yes",
    },
  });

  assert.equal(result.spec.env.DEV_EXEC_TARGET_ALIAS, "");
  assert.equal(capture.options.env.DEV_EXEC_TARGET_ALIAS, "");
  assert.equal(capture.options.env.DEV_EXEC_MISSION_CONSTRAINTS_JSON, "[]");
  assert.equal(capture.options.env.KEEP_ME, "yes");
  assert.equal(result.launch.status, "LAUNCHED");
});

test("explicit child target alias overrides inherited parent target alias", async () => {
  const {capture, result} = await dispatch({
    target_alias: "child-target",
    spawn_env: {DEV_EXEC_TARGET_ALIAS: "parent-target"},
  });

  assert.equal(result.spec.env.DEV_EXEC_TARGET_ALIAS, "child-target");
  assert.equal(capture.options.env.DEV_EXEC_TARGET_ALIAS, "child-target");
});
