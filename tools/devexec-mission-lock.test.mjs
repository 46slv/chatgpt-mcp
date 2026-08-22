import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {acquireMissionLock, missionLockPath, withMissionLock} from "./devexec-mission-lock.mjs";

function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-lock-"));
  return Promise.resolve(fn(root)).finally(() => fs.rmSync(root, {recursive: true, force: true}));
}

test("second writer fails closed while mission lock is held", () => withRoot(root => {
  const first = acquireMissionLock(root, {owner: "writer-A", now: "2026-08-23T05:20:00+09:00"});
  try {
    assert.throws(() => acquireMissionLock(root, {owner: "writer-B"}), /MISSION_CONTROL_LOCKED/);
    const record = JSON.parse(fs.readFileSync(missionLockPath(root), "utf8"));
    assert.equal(record.owner, "writer-A");
    assert.equal(record.token, first.token);
  } finally {
    first.release();
  }
}));

test("released mission lock can be reacquired", () => withRoot(root => {
  const first = acquireMissionLock(root);
  assert.equal(first.release(), true);
  const second = acquireMissionLock(root);
  assert.notEqual(second.token, first.token);
  second.release();
  assert.equal(fs.existsSync(missionLockPath(root)), false);
}));

test("callback failure releases a live lock but never auto-takes over a stale lock", () => withRoot(root => {
  assert.throws(
    () => withMissionLock(root, () => { throw new Error("mutation failed"); }),
    /mutation failed/,
  );
  assert.equal(fs.existsSync(missionLockPath(root)), false);

  fs.writeFileSync(missionLockPath(root), JSON.stringify({
    protocol: "devexec.mission-lock",
    schema_version: 1,
    token: "stale-token",
    owner: "unknown-prior-process",
    acquired_at: "2026-08-23T00:00:00+09:00",
  }) + "\n");
  assert.throws(() => acquireMissionLock(root), /MISSION_CONTROL_LOCKED/);
  assert.equal(fs.existsSync(missionLockPath(root)), true);
}));
