import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {acquireMissionLock, missionLockPath, withMissionLock} from "./devexec-mission-lock.mjs";

function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-lock-lifetime-"));
  return Promise.resolve(fn(root)).finally(() => fs.rmSync(root, {recursive: true, force: true}));
}

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

test("declared async callback is rejected before its body can start", () => withRoot(root => {
  let callbackCalls = 0;
  assert.throws(
    () => withMissionLock(root, async () => {
      callbackCalls += 1;
      await Promise.resolve();
      callbackCalls += 1;
    }),
    /MISSION_LOCK_ASYNC_CALLBACK_UNSUPPORTED/,
  );
  assert.equal(callbackCalls, 0);
  assert.equal(fs.existsSync(missionLockPath(root)), false);
}));

test("promise-returning wrapper keeps lock held until continuation settles", () => withRoot(async root => {
  let releaseGate;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  let competingAcquire = null;

  assert.throws(
    () => withMissionLock(root, () => gate.then(() => {
      try {
        const competing = acquireMissionLock(root, {owner: "escaped-async-continuation"});
        competingAcquire = true;
        competing.release();
      } catch (error) {
        if (error?.message === "MISSION_CONTROL_LOCKED") {
          competingAcquire = false;
          return;
        }
        throw error;
      }
    })),
    error => {
      assert.equal(error?.message, "MISSION_LOCK_ASYNC_CALLBACK_UNSUPPORTED");
      assert.equal(error?.lock_release_deferred, true);
      return true;
    },
  );

  assert.equal(fs.existsSync(missionLockPath(root)), true, "lock must remain held while thenable is pending");
  releaseGate();
  await nextTurn();
  await nextTurn();
  assert.equal(competingAcquire, false, "async continuation must not observe an unlocked Mission state");
  assert.equal(fs.existsSync(missionLockPath(root)), false, "lock should release only after continuation settles");
}));
