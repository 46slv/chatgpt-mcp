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
} else if (helperMode === "recover_then_acquire") {
  const root = process.env.DEVEXEC_MISSION_LOCK_RECOVERY_ROOT;
  if (!root) process.exit(92);
  const marker = process.env.DEVEXEC_MISSION_LOCK_RECOVERY_MARKER;
  try {
    recoverStaleMissionLock(root);
    const replacement = acquireMissionLock(root, {owner: `replacement-helper:${process.pid}`});
    if (marker) {
      fs.writeFileSync(marker, JSON.stringify({token: replacement.token, pid: process.pid}) + "\n", "utf8");
    }
    process.exit(78);
  } catch (error) {
    if (error?.message === "MISSION_CONTROL_LOCK_RECOVERY_ALREADY_CLAIMED") process.exit(79);
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
    return inspectMissionLock(root);
  }

  test("explicit recovery quarantines a dead-owner lock and allows a later acquire", () => withRoot(root => {
    const inspected = crashWithLock(root);
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

  test("recovery claim excludes a concurrent recoverer before canonical removal", () => withRoot(root => {
    const inspected = crashWithLock(root);
    assert.equal(inspected.status, "STALE");
    const canonical = missionLockPath(root);
    const marker = path.join(root, "replacement-marker.json");

    const originalRmSync = fs.rmSync;
    const originalRenameSync = fs.renameSync;
    let injected = false;
    const injectCompetitor = () => {
      if (injected) return;
      injected = true;
      const competitor = spawnSync(process.execPath, [self], {
        encoding: "utf8",
        env: {
          ...process.env,
          DEVEXEC_MISSION_LOCK_RECOVERY_HELPER: "recover_then_acquire",
          DEVEXEC_MISSION_LOCK_RECOVERY_ROOT: root,
          DEVEXEC_MISSION_LOCK_RECOVERY_MARKER: marker,
        },
      });
      assert.equal(competitor.status, 79, competitor.stderr || competitor.stdout);
    };

    fs.rmSync = (target, ...args) => {
      if (path.resolve(String(target)) === path.resolve(canonical)) injectCompetitor();
      return originalRmSync(target, ...args);
    };
    fs.renameSync = (from, to, ...args) => {
      if (path.resolve(String(from)) === path.resolve(canonical)) injectCompetitor();
      return originalRenameSync(from, to, ...args);
    };

    let recovered;
    try {
      recovered = recoverStaleMissionLock(root);
    } finally {
      fs.rmSync = originalRmSync;
      fs.renameSync = originalRenameSync;
    }

    assert.equal(injected, true);
    assert.equal(recovered.recovered, true);
    assert.equal(fs.existsSync(canonical), false);
    assert.equal(fs.existsSync(marker), false);
    const quarantined = JSON.parse(fs.readFileSync(recovered.quarantine_file, "utf8"));
    assert.equal(quarantined.token, inspected.record.token);
    assert.equal(quarantined.pid, inspected.record.pid);
  }));

  test("a replacement published before recovery claim validation is never removed", () => withRoot(root => {
    const inspected = crashWithLock(root);
    assert.equal(inspected.status, "STALE");
    const canonical = missionLockPath(root);
    const quarantine = `${canonical}.stale-${inspected.record.token}.json`;
    const originalLinkSync = fs.linkSync;
    let replacement = null;
    let injected = false;

    const patchedLinkSync = (from, to) => {
      if (
        !injected &&
        path.resolve(String(from)) === path.resolve(canonical) &&
        path.resolve(String(to)) === path.resolve(quarantine)
      ) {
        injected = true;
        fs.rmSync(canonical);
        fs.linkSync = originalLinkSync;
        try {
          replacement = acquireMissionLock(root, {owner: "replacement-before-recovery-claim"});
        } finally {
          fs.linkSync = patchedLinkSync;
        }
      }
      return originalLinkSync(from, to);
    };

    fs.linkSync = patchedLinkSync;
    try {
      assert.throws(
        () => recoverStaleMissionLock(root),
        /MISSION_CONTROL_LOCK_CHANGED_DURING_RECOVERY/,
      );
      assert.equal(injected, true);
      const current = inspectMissionLock(root);
      assert.equal(current.status, "HELD");
      assert.equal(current.record.token, replacement.token);
      assert.equal(fs.existsSync(quarantine), false);
    } finally {
      fs.linkSync = originalLinkSync;
      replacement?.release();
    }
  }));

  test("an interrupted recovery claim remains fail-closed instead of risking a replacement lock", () => withRoot(root => {
    const inspected = crashWithLock(root);
    assert.equal(inspected.status, "STALE");
    const canonical = missionLockPath(root);
    const quarantine = `${canonical}.stale-${inspected.record.token}.json`;

    // Model a process crash after the deterministic recovery claim is published
    // but before the stale canonical name is unlinked.
    fs.linkSync(canonical, quarantine);

    assert.throws(
      () => recoverStaleMissionLock(root),
      /MISSION_CONTROL_LOCK_RECOVERY_ALREADY_CLAIMED/,
    );
    assert.equal(inspectMissionLock(root).status, "STALE");
    assert.equal(fs.existsSync(canonical), true);
    assert.equal(fs.existsSync(quarantine), true);
    const claimed = JSON.parse(fs.readFileSync(quarantine, "utf8"));
    assert.equal(claimed.token, inspected.record.token);
  }));

  test("recovery fails closed when atomic claim publication is unavailable", () => withRoot(root => {
    const inspected = crashWithLock(root);
    assert.equal(inspected.status, "STALE");
    const canonical = missionLockPath(root);
    const quarantine = `${canonical}.stale-${inspected.record.token}.json`;
    const originalLinkSync = fs.linkSync;
    fs.linkSync = () => {
      const error = new Error("hard links unavailable");
      error.code = "EPERM";
      throw error;
    };
    try {
      assert.throws(
        () => recoverStaleMissionLock(root),
        error => {
          assert.equal(error?.message, "MISSION_CONTROL_LOCK_RECOVERY_ATOMIC_CLAIM_FAILED");
          assert.equal(error?.fs_code, "EPERM");
          return true;
        },
      );
    } finally {
      fs.linkSync = originalLinkSync;
    }
    assert.equal(inspectMissionLock(root).status, "STALE");
    assert.equal(fs.existsSync(canonical), true);
    assert.equal(fs.existsSync(quarantine), false);
  }));
}
