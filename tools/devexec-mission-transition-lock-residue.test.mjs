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
  return fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-lock-residue-"));
}

function isCorrupt(error) {
  return error instanceof MissionTransitionLockError && error.code === "MISSION_TRANSITION_LOCK_CORRUPT";
}

test("inspect rejects mixed published-owner and release-proof residue instead of hiding one owner", () => {
  const root = tmp();
  const missionId = "mission-mixed-release-residue";
  const held = acquireMissionTransitionLock({ stateDir: root, missionId, timeoutMs: 0 });
  const releaseNonce = "e".repeat(32);
  fs.writeFileSync(
    path.join(held.lock_path, `owner.release-${releaseNonce}.json`),
    `${JSON.stringify({ ...held.owner, owner_pid: process.pid + 1, nonce: releaseNonce })}\n`,
    "utf8",
  );

  assert.throws(
    () => inspectMissionTransitionLock({ stateDir: root, missionId }),
    isCorrupt,
  );
  assert.throws(
    () => acquireMissionTransitionLock({ stateDir: root, missionId, timeoutMs: 0 }),
    (error) => error instanceof MissionTransitionLockError && error.code === "MISSION_TRANSITION_BUSY",
  );
});

test("inspect rejects unknown residue alongside a published owner", () => {
  const root = tmp();
  const missionId = "mission-unknown-residue";
  const held = acquireMissionTransitionLock({ stateDir: root, missionId, timeoutMs: 0 });
  fs.writeFileSync(path.join(held.lock_path, "unexpected.tmp"), "ambiguous\n", "utf8");

  assert.throws(
    () => inspectMissionTransitionLock({ stateDir: root, missionId }),
    isCorrupt,
  );
});
