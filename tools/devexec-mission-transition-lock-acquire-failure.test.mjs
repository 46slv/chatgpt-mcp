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
  return fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-lock-acquire-failure-"));
}

test("failed owner publication never erases replacement metadata", () => {
  const root = tmp();
  const realOpenSync = fs.openSync;
  let injectedOwnerFile = null;

  fs.openSync = function patchedOpenSync(file, flags, mode) {
    if (!injectedOwnerFile && path.basename(file) === "owner.json" && flags === "wx") {
      injectedOwnerFile = file;
      const missionKey = path.basename(path.dirname(file), ".lock");
      const fd = realOpenSync.call(fs, file, "wx", 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify({
          protocol: "devexec.mission-transition-lock",
          schema_version: 1,
          mission_key: missionKey,
          owner_pid: process.pid + 1,
          acquired_at: "2026-09-07T00:00:00.000Z",
          nonce: "f".repeat(32),
        })}\n`, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      const error = new Error("simulated replacement before owner publication");
      error.code = "EEXIST";
      throw error;
    }
    return realOpenSync.call(fs, file, flags, mode);
  };

  try {
    assert.throws(
      () => acquireMissionTransitionLock({ stateDir: root, missionId: "mission-acquire-replaced", timeoutMs: 0 }),
      (error) => error instanceof MissionTransitionLockError && error.code === "MISSION_TRANSITION_LOCK_IO",
    );
  } finally {
    fs.openSync = realOpenSync;
  }

  assert.notEqual(injectedOwnerFile, null);
  assert.equal(fs.existsSync(injectedOwnerFile), true);
  const observed = inspectMissionTransitionLock({ stateDir: root, missionId: "mission-acquire-replaced" });
  assert.equal(observed.owner.nonce, "f".repeat(32));
  assert.throws(
    () => acquireMissionTransitionLock({ stateDir: root, missionId: "mission-acquire-replaced", timeoutMs: 0 }),
    (error) => error instanceof MissionTransitionLockError && error.code === "MISSION_TRANSITION_BUSY",
  );
});
