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

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "devexec-lock-id-")); }

for (const invalid of [undefined, null, "", "   "]) {
  test(`acquire rejects invalid missionId ${JSON.stringify(invalid)}`, () => {
    const root = tmp();
    assert.throws(
      () => acquireMissionTransitionLock({ stateDir: root, missionId: invalid, timeoutMs: 0 }),
      (error) => error instanceof MissionTransitionLockError
        && error.code === "MISSION_TRANSITION_LOCK_MISSION_ID_REQUIRED",
    );
    assert.equal(fs.existsSync(path.join(root, "mission-transition-locks")), false);
  });
  test(`inspect rejects invalid missionId ${JSON.stringify(invalid)}`, () => {
    const root = tmp();
    assert.throws(
      () => inspectMissionTransitionLock({ stateDir: root, missionId: invalid }),
      (error) => error instanceof MissionTransitionLockError
        && error.code === "MISSION_TRANSITION_LOCK_MISSION_ID_REQUIRED",
    );
  });
}
