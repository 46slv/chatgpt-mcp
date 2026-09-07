import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireMissionTransitionLock,
  inspectMissionTransitionLock,
} from "./devexec-mission-transition-lock.mjs";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-lock-inspect-race-"));
}

test("inspection tolerates a concurrent proven release without leaking ENOENT", () => {
  const root = tmp();
  const held = acquireMissionTransitionLock({ stateDir: root, missionId: "mission-inspect-release", timeoutMs: 0 });
  const realReaddirSync = fs.readdirSync;
  let releasedDuringInspection = false;

  fs.readdirSync = function patchedReaddirSync(directory, options) {
    const entries = realReaddirSync.call(fs, directory, options);
    if (!releasedDuringInspection && path.resolve(directory) === path.resolve(held.lock_path)) {
      releasedDuringInspection = true;
      held.release();
    }
    return entries;
  };

  try {
    assert.equal(inspectMissionTransitionLock({ stateDir: root, missionId: "mission-inspect-release" }), null);
  } finally {
    fs.readdirSync = realReaddirSync;
  }
  assert.equal(releasedDuringInspection, true);
});
