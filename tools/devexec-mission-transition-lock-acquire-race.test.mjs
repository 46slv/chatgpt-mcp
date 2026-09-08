import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MissionTransitionLockError,
  acquireMissionTransitionLock,
  inspectMissionTransitionLock,
} from "./devexec-mission-transition-lock.mjs";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-lock-acquire-race-"));
}

function simulatedExistingLockReleased(realMkdirSync, target, options) {
  realMkdirSync.call(fs, target, options);
  fs.rmdirSync(target);
  const error = new Error("simulated competing lock released before lstat");
  error.code = "EEXIST";
  throw error;
}

test("acquire retries when an existing lock is released before lstat", () => {
  const root = tmp();
  const realMkdirSync = fs.mkdirSync;
  let injected = false;
  fs.mkdirSync = function mkdirSyncAcquireRace(target, options) {
    if (!injected && String(target).endsWith(".lock")) {
      injected = true;
      return simulatedExistingLockReleased(realMkdirSync, target, options);
    }
    return realMkdirSync.call(fs, target, options);
  };

  let held;
  try {
    held = acquireMissionTransitionLock({
      stateDir: root,
      missionId: "mission-acquire-release-race",
      timeoutMs: 0,
    });
  } finally {
    fs.mkdirSync = realMkdirSync;
  }

  assert.equal(injected, true);
  held.release();
  assert.equal(
    inspectMissionTransitionLock({ stateDir: root, missionId: "mission-acquire-release-race" }),
    null,
  );
});

test("repeated acquire path churn fails with a bounded structured error", () => {
  const root = tmp();
  const realMkdirSync = fs.mkdirSync;
  let injected = 0;
  fs.mkdirSync = function mkdirSyncAcquireChurn(target, options) {
    if (String(target).endsWith(".lock")) {
      injected += 1;
      return simulatedExistingLockReleased(realMkdirSync, target, options);
    }
    return realMkdirSync.call(fs, target, options);
  };

  try {
    assert.throws(
      () => acquireMissionTransitionLock({
        stateDir: root,
        missionId: "mission-acquire-path-churn",
        timeoutMs: 0,
      }),
      (error) => error instanceof MissionTransitionLockError
        && error.code === "MISSION_TRANSITION_LOCK_UNSTABLE",
    );
  } finally {
    fs.mkdirSync = realMkdirSync;
  }

  assert.equal(injected, 3);
});
