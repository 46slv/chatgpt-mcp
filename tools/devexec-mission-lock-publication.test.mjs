import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

import {recoverOrResumeStaleMissionLock} from "./devexec-mission-lock-resume.mjs";

import {
  acquireMissionLock,
  inspectMissionLock,
  missionLockPath,
} from "./devexec-mission-lock.mjs";

const self = fileURLToPath(import.meta.url);
const helperMode = process.env.DEVEXEC_MISSION_LOCK_PUBLICATION_HELPER ?? "";

function stagingFiles(root) {
  const canonical = path.basename(missionLockPath(root));
  return fs.readdirSync(root)
    .filter(name => name.startsWith(`${canonical}.claim-`) && name.endsWith(".tmp"))
    .map(name => path.join(root, name));
}

if (helperMode === "crash_before_publish") {
  const root = process.env.DEVEXEC_MISSION_LOCK_PUBLICATION_ROOT;
  if (!root) process.exit(91);
  const canonical = missionLockPath(root);
  const originalLinkSync = fs.linkSync;
  fs.linkSync = (existingPath, newPath) => {
    if (path.resolve(newPath) === path.resolve(canonical)) process.exit(71);
    return originalLinkSync(existingPath, newPath);
  };
  acquireMissionLock(root, {owner: `before-publish:${process.pid}`});
  process.exit(92);
} else if (helperMode === "crash_after_publish") {
  const root = process.env.DEVEXEC_MISSION_LOCK_PUBLICATION_ROOT;
  if (!root) process.exit(93);
  const canonical = missionLockPath(root);
  const stagingPrefix = `${canonical}.claim-`;
  const originalRmSync = fs.rmSync;
  fs.rmSync = (target, ...args) => {
    const resolved = path.resolve(String(target));
    if (
      resolved.startsWith(path.resolve(stagingPrefix)) &&
      fs.existsSync(canonical)
    ) {
      process.exit(72);
    }
    return originalRmSync(target, ...args);
  };
  acquireMissionLock(root, {owner: `after-publish:${process.pid}`});
  process.exit(94);
} else {
  function withRoot(fn) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-lock-publication-"));
    return Promise.resolve(fn(root)).finally(() => fs.rmSync(root, {recursive: true, force: true}));
  }

  function runHelper(root, mode) {
    return spawnSync(process.execPath, [self], {
      encoding: "utf8",
      env: {
        ...process.env,
        DEVEXEC_MISSION_LOCK_PUBLICATION_HELPER: mode,
        DEVEXEC_MISSION_LOCK_PUBLICATION_ROOT: root,
      },
    });
  }

  test("crash before atomic publish never exposes an invalid canonical lock", () => withRoot(root => {
    const crashed = runHelper(root, "crash_before_publish");
    assert.equal(crashed.status, 71, crashed.stderr || crashed.stdout);

    assert.equal(fs.existsSync(missionLockPath(root)), false);
    assert.equal(inspectMissionLock(root).status, "UNLOCKED");
    assert.equal(stagingFiles(root).length, 1);

    // A fully written but unpublished orphan cannot block a later canonical
    // acquire. It is non-authoritative by construction.
    const next = acquireMissionLock(root, {owner: "after-before-publish-crash"});
    assert.equal(inspectMissionLock(root).status, "HELD");
    next.release();
    assert.equal(inspectMissionLock(root).status, "UNLOCKED");
  }));

  test("crash after atomic publish leaves a complete recoverable canonical record", () => withRoot(root => {
    const crashed = runHelper(root, "crash_after_publish");
    assert.equal(crashed.status, 72, crashed.stderr || crashed.stdout);

    assert.equal(fs.existsSync(missionLockPath(root)), true);
    const inspected = inspectMissionLock(root);
    assert.equal(inspected.status, "STALE");
    assert.equal(inspected.recoverable, true);
    assert.equal(inspected.record.publication, "hardlink-v1");
    assert.match(inspected.record.owner, /^after-publish:/);
    assert.equal(stagingFiles(root).length, 1);

    const recovered = recoverOrResumeStaleMissionLock(root);
    assert.equal(recovered.recovered, true);
    assert.equal(fs.existsSync(missionLockPath(root)), false);
    assert.equal(fs.existsSync(recovered.quarantine_file), true);

    const next = acquireMissionLock(root, {owner: "after-publish-recovery"});
    next.release();
  }));

  test("atomic publish failure leaves no canonical lock or staging artifact", () => withRoot(root => {
    const originalLinkSync = fs.linkSync;
    fs.linkSync = () => {
      const error = new Error("hard links unavailable");
      error.code = "EPERM";
      throw error;
    };
    try {
      assert.throws(
        () => acquireMissionLock(root, {owner: "unsupported-hardlink"}),
        error => {
          assert.equal(error?.message, "MISSION_CONTROL_LOCK_ATOMIC_PUBLISH_FAILED");
          assert.equal(error?.fs_code, "EPERM");
          return true;
        },
      );
    } finally {
      fs.linkSync = originalLinkSync;
    }
    assert.equal(fs.existsSync(missionLockPath(root)), false);
    assert.deepEqual(stagingFiles(root), []);
    assert.equal(inspectMissionLock(root).status, "UNLOCKED");
  }));

  test("normal acquisition removes its staging alias after publication", () => withRoot(root => {
    const lock = acquireMissionLock(root, {owner: "normal-publish"});
    const inspected = inspectMissionLock(root);
    assert.equal(inspected.status, "HELD");
    assert.equal(inspected.record.publication, "hardlink-v1");
    assert.deepEqual(stagingFiles(root), []);
    lock.release();
  }));
}
