import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {openMissionControl} from "./devexec-mission-control.mjs";
import {startMissionLocalAgent} from "./devexec-mission-entry-runtime.mjs";
import {acquireMissionLock, missionLockPath} from "./devexec-mission-lock.mjs";
import {loadMissionState, resolveMissionPaths} from "./devexec-mission-state.mjs";

function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-entry-runtime-"));
  return Promise.resolve(fn(root)).finally(() => fs.rmSync(root, {recursive: true, force: true}));
}

const rootIdentity = {mission_id: "MISSION-001", run_id: "RUN-001", parent_run_id: null};
const childIdentity = {mission_id: "MISSION-001", run_id: "RUN-002", parent_run_id: "RUN-001"};

test("root Mission is durable before Local Agent start is invoked", () => withRoot(root => {
  let observed = null;
  const result = startMissionLocalAgent({
    base: root,
    identity: rootIdentity,
    start_local_agent: () => {
      observed = loadMissionState(resolveMissionPaths(root, "MISSION-001").state_file);
      return {run_id: "AGENT-ROOT", decision: "COMPLETE"};
    },
  });
  assert.equal(observed.current_run_id, "RUN-001");
  assert.equal(result.agent.run_id, "AGENT-ROOT");
  assert.equal(result.mission.state.current_run_id, "RUN-001");
  assert.equal(result.lock_recovery.recovered, false);
}));

test("child is STARTING and parent remains current during the Local Agent side effect", () => withRoot(root => {
  openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  let duringStart = null;
  const result = startMissionLocalAgent({
    base: root,
    identity: childIdentity,
    start_attempt_id: "START-001",
    start_local_agent: () => {
      duringStart = loadMissionState(resolveMissionPaths(root, "MISSION-001").state_file);
      return {run_id: "AGENT-CHILD", decision: "NEEDS_SUPERVISOR"};
    },
  });

  const childDuring = duringStart.runs.find(run => run.run_id === "RUN-002");
  assert.equal(duringStart.current_run_id, "RUN-001");
  assert.equal(childDuring.status, "STARTING");
  assert.equal(childDuring.start_attempt_id, "START-001");
  assert.equal(result.mission.state.current_run_id, "RUN-002");
  assert.equal(result.mission.state.runs.find(run => run.run_id === "RUN-002").status, "ACTIVE");
}));

test("Local Agent start failure becomes durable AMBIGUOUS and is never automatically replayed", () => withRoot(root => {
  openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  let calls = 0;
  assert.throws(
    () => startMissionLocalAgent({
      base: root,
      identity: childIdentity,
      start_attempt_id: "START-001",
      start_local_agent: () => {
        calls += 1;
        throw new Error("unreadable start result");
      },
    }),
    /unreadable start result/,
  );

  const state = loadMissionState(resolveMissionPaths(root, "MISSION-001").state_file);
  const child = state.runs.find(run => run.run_id === "RUN-002");
  assert.equal(state.current_run_id, "RUN-001");
  assert.equal(child.status, "AMBIGUOUS");
  assert.match(child.ambiguous_reason, /unreadable start result/);

  assert.throws(
    () => startMissionLocalAgent({
      base: root,
      identity: childIdentity,
      start_attempt_id: "START-002",
      start_local_agent: () => {
        calls += 1;
        return {run_id: "MUST-NOT-RUN"};
      },
    }),
    /MISSION_CHILD_START_AMBIGUOUS/,
  );
  assert.equal(calls, 1);
}));

test("invalid Local Agent result is treated as ambiguous after the STARTING fence", () => withRoot(root => {
  openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  assert.throws(
    () => startMissionLocalAgent({
      base: root,
      identity: childIdentity,
      start_attempt_id: "START-001",
      start_local_agent: () => ({decision: "COMPLETE"}),
    }),
    /LOCAL_AGENT_START_RESULT_INVALID/,
  );
  const child = loadMissionState(resolveMissionPaths(root, "MISSION-001").state_file)
    .runs.find(run => run.run_id === "RUN-002");
  assert.equal(child.status, "AMBIGUOUS");
}));

test("Mission entry quarantines a verified dead-owner lock before any Local Agent side effect", () => withRoot(root => {
  const paths = resolveMissionPaths(root, "MISSION-001");
  const lockFile = missionLockPath(paths.root);
  const crashed = spawnSync(process.execPath, ["-e", [
    'const fs=require("node:fs");',
    'const path=require("node:path");',
    `const file=${JSON.stringify(lockFile)};`,
    'fs.mkdirSync(path.dirname(file),{recursive:true});',
    'fs.writeFileSync(file,JSON.stringify({protocol:"devexec.mission-lock",schema_version:1,token:"dead-token",owner:`dead-helper:${process.pid}`,pid:process.pid,acquired_at:new Date().toISOString()},null,2)+"\\n","utf8");',
    'process.exit(77);',
  ].join("")], {encoding: "utf8"});
  assert.equal(crashed.status, 77, crashed.stderr || crashed.stdout);

  let calls = 0;
  const result = startMissionLocalAgent({
    base: root,
    identity: rootIdentity,
    start_attempt_id: "START-RECOVERY-001",
    start_local_agent: () => {
      calls += 1;
      return {run_id: "AGENT-RECOVERED", decision: "COMPLETE"};
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.agent.run_id, "AGENT-RECOVERED");
  assert.equal(result.lock_recovery.recovered, true);
  assert.equal(result.lock_recovery.status, "STALE_RECOVERED");
  assert.equal(fs.existsSync(lockFile), false);
  assert.equal(fs.existsSync(result.lock_recovery.quarantine_file), true);
}));

test("Mission entry never steals a live lock and never invokes Local Agent", () => withRoot(root => {
  const paths = resolveMissionPaths(root, "MISSION-001");
  const live = acquireMissionLock(paths.root, {owner: "live-entry-owner"});
  let calls = 0;
  try {
    assert.throws(
      () => startMissionLocalAgent({
        base: root,
        identity: rootIdentity,
        start_attempt_id: "START-LIVE-LOCK",
        start_local_agent: () => {
          calls += 1;
          return {run_id: "MUST-NOT-RUN"};
        },
      }),
      /MISSION_CONTROL_LOCKED/,
    );
    assert.equal(calls, 0);
    assert.equal(fs.existsSync(missionLockPath(paths.root)), true);
  } finally {
    live.release();
  }
}));

test("Mission entry keeps legacy no-PID lock fail-closed before Local Agent", () => withRoot(root => {
  const paths = resolveMissionPaths(root, "MISSION-001");
  const lockFile = missionLockPath(paths.root);
  fs.mkdirSync(path.dirname(lockFile), {recursive: true});
  fs.writeFileSync(lockFile, JSON.stringify({
    protocol: "devexec.mission-lock",
    schema_version: 1,
    token: "legacy-token",
    owner: "legacy-owner",
    acquired_at: new Date().toISOString(),
  }, null, 2) + "\n", "utf8");

  let calls = 0;
  assert.throws(
    () => startMissionLocalAgent({
      base: root,
      identity: rootIdentity,
      start_attempt_id: "START-LEGACY-LOCK",
      start_local_agent: () => {
        calls += 1;
        return {run_id: "MUST-NOT-RUN"};
      },
    }),
    /MISSION_CONTROL_LOCK_RECOVERY_UNSAFE/,
  );
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(lockFile), true);
}));
