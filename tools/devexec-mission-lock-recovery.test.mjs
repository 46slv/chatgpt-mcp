import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

import {
  acquireMissionLock,
  inspectMissionLock,
  missionLockPath,
  recoverStaleMissionLock,
} from "./devexec-mission-lock.mjs";

const self = fileURLToPath(import.meta.url);
const helperMode = process.env.DEVEXEC_MISSION_LOCK_RECOVERY_HELPER ?? "";

if (helperMode === "crash_with_lock") {
  const root = process.env.DEVEXEC_MISSION_LOCK_RECOVERY_ROOT;
  if (!root) process.exit(91);
  acquireMissionLock(root, {owner: `recovery-helper:${process.pid}`});
  process.exit(77);
} else {
  function withRoot(fn) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-lock-recovery-"));
    return Promise.resolve(fn(root)).finally(() => fs.rmSync(root, {recursive: true, force: true}));
  }

  test("explicit recovery quarantines a dead-owner lock and allows a later acquire", () => withRoot(root => {
    const crashed = spawnSync(process.execPath, [self], {
      encoding: "utf8",
      env: {
        ...process.env,
        DEVEXEC_MISSION_LOCK_RECOVERY_HELPER: "crash_with_lock",
        DEVEXEC_MISSION_LOCK_RECOVERY_ROOT: root,
      },
    });
    assert.equal(crashed.status, 77, crashed.stderr || crashed.stdout);

    const inspected = inspectMissionLock(root);
    assert.equal(inspected.status, "STALE");
    assert.equal(inspected.recoverable, true);
    assert.ok(Number.isSafeInteger(inspected.record.pid));
    assert.equal(inspected.record.owner, `recovery-helper:${inspected.record.pid}`);
    assert.equal(fs.existsSync(missionLockPath(root)), true);

    const recovered = recoverStaleMissionLock(root);
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.status, "STALE_RECOVERED");
    assert.equal(fs.existsSync(missionLockPath(root)), false);
    assert.equal(fs.existsSync(recovered.quarantine_file), true);
    const quarantined = JSON.parse(fs.readFileSync(recovered.quarantine_file, "utf8"));
    assert.equal(quarantined.token, inspected.record.token);
    assert.equal(quarantined.pid, inspected.record.pid);

    const after = acquireMissionLock(root, {owner: "after-recovery"});
    assert.equal(inspectMissionLock(root).status, "HELD");
    after.release();
    assert.equal(inspectMissionLock(root).status, "UNLOCKED");
  }));

  test("explicit recovery refuses a live owner and leaves its lock untouched", () => withRoot(root => {
    const live = acquireMissionLock(root, {owner: "live-owner"});
    try {
      const inspected = inspectMissionLock(root);
      assert.equal(inspected.status, "HELD");
      assert.equal(inspected.recoverable, false);
      assert.equal(inspected.record.pid, process.pid);
      assert.throws(() => recoverStaleMissionLock(root), /MISSION_CONTROL_LOCK_OWNER_ALIVE/);
      assert.equal(fs.existsSync(missionLockPath(root)), true);
    } finally {
      live.release();
    }
  }));

  test("legacy lock without a durable pid remains fail-closed", () => withRoot(root => {
    const file = missionLockPath(root);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, JSON.stringify({
      protocol: "devexec.mission-lock",
      schema_version: 1,
      token: "legacy-token",
      owner: "legacy-owner",
      acquired_at: new Date().toISOString(),
    }, null, 2) + "\n", "utf8");

    const inspected = inspectMissionLock(root);
    assert.equal(inspected.status, "UNKNOWN_OWNER");
    assert.equal(inspected.recoverable, false);
    assert.throws(() => recoverStaleMissionLock(root), /MISSION_CONTROL_LOCK_RECOVERY_UNSAFE/);
    assert.equal(fs.existsSync(file), true);
  }));
}
