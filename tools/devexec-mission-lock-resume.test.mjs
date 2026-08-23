import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

import {acquireMissionLock, inspectMissionLock, missionLockPath} from "./devexec-mission-lock.mjs";
import {recoverOrResumeStaleMissionLock} from "./devexec-mission-lock-resume.mjs";

const self = fileURLToPath(import.meta.url);
const helperMode = process.env.DEVEXEC_MISSION_RESUME_HELPER ?? "";

if (helperMode === "crash_with_lock") {
  const root = process.env.DEVEXEC_MISSION_RESUME_ROOT;
  if (!root) process.exit(91);
  acquireMissionLock(root, {owner: `resume-helper:${process.pid}`});
  process.exit(77);
} else if (helperMode === "crash_during_recovery") {
  const root = process.env.DEVEXEC_MISSION_RESUME_ROOT;
  if (!root) process.exit(92);
  const canonical = missionLockPath(root);
  const originalRmSync = fs.rmSync;
  fs.rmSync = (target, ...args) => {
    if (path.resolve(String(target)) === path.resolve(canonical)) process.exit(78);
    return originalRmSync(target, ...args);
  };
  recoverOrResumeStaleMissionLock(root);
  process.exit(93);
} else {
  function withRoot(fn) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-lock-resume-"));
    return Promise.resolve(fn(root)).finally(() => fs.rmSync(root, {recursive: true, force: true}));
  }

  function crashWithLock(root) {
    const crashed = spawnSync(process.execPath, [self], {
      encoding: "utf8",
      env: {...process.env, DEVEXEC_MISSION_RESUME_HELPER: "crash_with_lock", DEVEXEC_MISSION_RESUME_ROOT: root},
    });
    assert.equal(crashed.status, 77, crashed.stderr || crashed.stdout);
    const inspected = inspectMissionLock(root);
    assert.equal(inspected.status, "STALE");
    return inspected;
  }

  function baseClaim(canonical, token) {
    return `${canonical}.stale-${token}.json`;
  }

  function ownerClaim(canonical, token, recoveryPid, recoveryToken) {
    return `${canonical}.stale-${token}.recover-${recoveryPid}-${recoveryToken}.json`;
  }

  test("resumes neutral recovery evidence using movable-owner v2", () => withRoot(root => {
    const inspected = crashWithLock(root);
    const canonical = missionLockPath(root);
    fs.linkSync(canonical, baseClaim(canonical, inspected.record.token));
    const recovered = recoverOrResumeStaleMissionLock(root);
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.recovery_claim_mode, "movable-owner-v2");
    assert.equal(fs.existsSync(canonical), false);
  }));

  test("resumes after a recovery process exits after owner claim before canonical unlink", () => withRoot(root => {
    const inspected = crashWithLock(root);
    const canonical = missionLockPath(root);
    const crashed = spawnSync(process.execPath, [self], {
      encoding: "utf8",
      env: {...process.env, DEVEXEC_MISSION_RESUME_HELPER: "crash_during_recovery", DEVEXEC_MISSION_RESUME_ROOT: root},
    });
    assert.equal(crashed.status, 78, crashed.stderr || crashed.stdout);
    assert.equal(fs.existsSync(canonical), true);

    const recovered = recoverOrResumeStaleMissionLock(root);
    assert.equal(recovered.recovered, true);
    assert.equal(fs.existsSync(canonical), false);
    const quarantine = JSON.parse(fs.readFileSync(recovered.quarantine_file, "utf8"));
    assert.equal(quarantine.token, inspected.record.token);
  }));

  test("does not steal a live recovery owner", () => withRoot(root => {
    const inspected = crashWithLock(root);
    const canonical = missionLockPath(root);
    const owner = ownerClaim(canonical, inspected.record.token, process.pid, "live-recoverer");
    fs.linkSync(canonical, owner);
    assert.throws(
      () => recoverOrResumeStaleMissionLock(root),
      error => error?.message === "MISSION_CONTROL_LOCK_RECOVERY_ALREADY_CLAIMED",
    );
    assert.equal(fs.existsSync(canonical), true);
    assert.equal(fs.existsSync(owner), true);
  }));

  test("fails closed without mutation when live owner and neutral evidence coexist", () => withRoot(root => {
    const inspected = crashWithLock(root);
    const canonical = missionLockPath(root);
    const base = baseClaim(canonical, inspected.record.token);
    const owner = ownerClaim(canonical, inspected.record.token, process.pid, "mixed-live-owner");
    fs.linkSync(canonical, owner);
    fs.linkSync(canonical, base);

    assert.throws(
      () => recoverOrResumeStaleMissionLock(root),
      error => error?.message === "MISSION_CONTROL_LOCK_RECOVERY_MIXED_CLAIMS",
    );
    assert.equal(fs.existsSync(canonical), true);
    assert.equal(fs.existsSync(owner), true);
    assert.equal(fs.existsSync(base), true);
  }));

  test("matching JSON is insufficient when recovery evidence is a copied file", () => withRoot(root => {
    const inspected = crashWithLock(root);
    const canonical = missionLockPath(root);
    const fakeOwner = ownerClaim(canonical, inspected.record.token, inspected.record.pid, "copied-evidence");
    fs.writeFileSync(fakeOwner, fs.readFileSync(canonical));
    assert.throws(() => recoverOrResumeStaleMissionLock(root), /MISSION_CONTROL_LOCK_RECOVERY_IDENTITY_MISMATCH/);
    assert.equal(fs.existsSync(canonical), true);
  }));

  test("multiple PID-bearing recovery claims remain fail-closed", () => withRoot(root => {
    const inspected = crashWithLock(root);
    const canonical = missionLockPath(root);
    const a = ownerClaim(canonical, inspected.record.token, inspected.record.pid, "dead-a");
    const b = ownerClaim(canonical, inspected.record.token, inspected.record.pid, "dead-b");
    fs.linkSync(canonical, a);
    fs.linkSync(canonical, b);
    assert.throws(() => recoverOrResumeStaleMissionLock(root), /MISSION_CONTROL_LOCK_RECOVERY_MULTIPLE_CLAIMS/);
    assert.equal(fs.existsSync(canonical), true);
  }));
}
