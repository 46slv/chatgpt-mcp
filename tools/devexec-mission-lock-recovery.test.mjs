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
import {recoverOrResumeStaleMissionLock} from "./devexec-mission-lock-resume.mjs";

const self = fileURLToPath(import.meta.url);
const helperMode = process.env.DEVEXEC_MISSION_LOCK_RECOVERY_HELPER ?? "";

if (helperMode === "crash_with_lock") {
  const root = process.env.DEVEXEC_MISSION_LOCK_RECOVERY_ROOT;
  if (!root) process.exit(91);
  acquireMissionLock(root, {owner: `recovery-helper:${process.pid}`});
  process.exit(77);
} else if (helperMode === "recover_then_acquire") {
  const root = process.env.DEVEXEC_MISSION_LOCK_RECOVERY_ROOT;
  if (!root) process.exit(92);
  try {
    recoverOrResumeStaleMissionLock(root);
    acquireMissionLock(root, {owner: `replacement-helper:${process.pid}`});
    process.exit(78);
  } catch (error) {
    if ([
      "MISSION_CONTROL_LOCK_RECOVERY_ALREADY_CLAIMED",
      "MISSION_CONTROL_LOCK_RECOVERY_MIXED_CLAIMS",
    ].includes(error?.message)) process.exit(79);
    process.stderr.write(`${error?.stack || error}\n`);
    process.exit(80);
  }
} else {
  function withRoot(fn) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-lock-recovery-"));
    return Promise.resolve(fn(root)).finally(() => fs.rmSync(root, {recursive: true, force: true}));
  }

  function crashWithLock(root) {
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
    return inspected;
  }

  test("resumable arbiter quarantines a dead-owner lock and allows later acquire", () => withRoot(root => {
    const inspected = crashWithLock(root);
    const recovered = recoverOrResumeStaleMissionLock(root);
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.status, "STALE_RECOVERED");
    assert.equal(recovered.recovery_claim_mode, "movable-owner-v2");
    assert.equal(fs.existsSync(missionLockPath(root)), false);
    assert.equal(fs.existsSync(recovered.quarantine_file), true);
    const quarantined = JSON.parse(fs.readFileSync(recovered.quarantine_file, "utf8"));
    assert.equal(quarantined.token, inspected.record.token);
    assert.equal(quarantined.pid, inspected.record.pid);

    const after = acquireMissionLock(root, {owner: "after-recovery"});
    assert.equal(inspectMissionLock(root).status, "HELD");
    after.release();
  }));

  test("resumable arbiter refuses a live owner and leaves canonical lock untouched", () => withRoot(root => {
    const live = acquireMissionLock(root, {owner: "live-owner"});
    try {
      assert.throws(() => recoverOrResumeStaleMissionLock(root), /MISSION_CONTROL_LOCK_OWNER_ALIVE/);
      assert.equal(fs.existsSync(missionLockPath(root)), true);
    } finally {
      live.release();
    }
  }));

  test("legacy lock without durable pid remains fail-closed in the resumable arbiter", () => withRoot(root => {
    const file = missionLockPath(root);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, JSON.stringify({
      protocol: "devexec.mission-lock",
      schema_version: 1,
      token: "legacy-token",
      owner: "legacy-owner",
      acquired_at: new Date().toISOString(),
    }, null, 2) + "\n", "utf8");

    assert.equal(inspectMissionLock(root).status, "UNKNOWN_OWNER");
    assert.throws(() => recoverOrResumeStaleMissionLock(root), /MISSION_CONTROL_LOCK_RECOVERY_UNSAFE/);
    assert.equal(fs.existsSync(file), true);
  }));

  test("legacy recovery export is retired and cannot mutate a stale canonical lock", () => withRoot(root => {
    const inspected = crashWithLock(root);
    const canonical = missionLockPath(root);
    assert.throws(
      () => recoverStaleMissionLock(root),
      error => {
        assert.equal(error?.message, "MISSION_CONTROL_LOCK_RECOVERY_LEGACY_MUTATOR_RETIRED");
        assert.equal(error?.lock_status, "STALE");
        assert.equal(error?.recovery_api, "recoverOrResumeStaleMissionLock");
        return true;
      },
    );
    assert.equal(fs.existsSync(canonical), true);
    assert.equal(inspectMissionLock(root).record.token, inspected.record.token);
  }));

  test("live recovery ownership excludes a concurrent resumable recoverer", () => withRoot(root => {
    const inspected = crashWithLock(root);
    const canonical = missionLockPath(root);
    const base = `${canonical}.stale-${inspected.record.token}.json`;
    const owner = `${canonical}.stale-${inspected.record.token}.recover-${process.pid}-test-owner.json`;
    fs.linkSync(canonical, base);
    fs.renameSync(base, owner);

    const competitor = spawnSync(process.execPath, [self], {
      encoding: "utf8",
      env: {
        ...process.env,
        DEVEXEC_MISSION_LOCK_RECOVERY_HELPER: "recover_then_acquire",
        DEVEXEC_MISSION_LOCK_RECOVERY_ROOT: root,
      },
    });
    assert.equal(competitor.status, 79, competitor.stderr || competitor.stdout);
    assert.equal(fs.existsSync(canonical), true);
    assert.equal(fs.existsSync(owner), true);
  }));
}
