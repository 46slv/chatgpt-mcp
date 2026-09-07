import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MissionTransitionLockError,
  acquireMissionTransitionLock,
} from "./devexec-mission-transition-lock.mjs";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-lock-release-race-"));
}

test("release preserves owner metadata replaced after validation and keeps the Mission blocked", () => {
  const root = tmp();
  const held = acquireMissionTransitionLock({ stateDir: root, missionId: "mission-release-race", timeoutMs: 0 });
  const ownerFile = path.join(held.lock_path, "owner.json");
  const realReadFileSync = fs.readFileSync;
  let injected = false;

  fs.readFileSync = function patchedReadFileSync(file, ...args) {
    const value = realReadFileSync.call(fs, file, ...args);
    if (!injected && path.resolve(String(file)) === path.resolve(ownerFile)) {
      injected = true;
      const owner = JSON.parse(String(value));
      fs.writeFileSync(ownerFile, `${JSON.stringify({
        ...owner,
        owner_pid: process.pid + 1,
        nonce: "f".repeat(32),
      })}\n`, "utf8");
    }
    return value;
  };

  try {
    assert.throws(
      () => held.release(),
      (error) => error instanceof MissionTransitionLockError && error.code === "MISSION_TRANSITION_LOCK_REPLACED",
    );
  } finally {
    fs.readFileSync = realReadFileSync;
  }

  assert.equal(injected, true);
  assert.equal(fs.existsSync(held.lock_path), true);
  const entries = fs.readdirSync(held.lock_path);
  assert.equal(entries.length > 0, true);
  const preservedOwner = entries
    .map((entry) => path.join(held.lock_path, entry))
    .find((entry) => fs.lstatSync(entry).isFile());
  assert.ok(preservedOwner);
  const observed = JSON.parse(fs.readFileSync(preservedOwner, "utf8"));
  assert.equal(observed.nonce, "f".repeat(32));
  assert.throws(
    () => acquireMissionTransitionLock({ stateDir: root, missionId: "mission-release-race", timeoutMs: 0 }),
    (error) => error instanceof MissionTransitionLockError && error.code === "MISSION_TRANSITION_BUSY",
  );
});
