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
} else {
  function withRoot(fn) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-lock-resume-"));
    return Promise.resolve(fn(root)).finally(() => fs.rmSync(root, {recursive: true, force: true}));
  }

  function crashWithLock(root) {
    const crashed = spawnSync(process.execPath, [self], {
      encoding: "utf8",
      env: {
        ...process.env,
        DEVEXEC_MISSION_RESUME_HELPER: "crash_with_lock",
        DEVEXEC_MISSION_RESUME_ROOT: root,
      },
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

  test("resumes a crash after neutral recovery evidence was published before canonical unlink", () => withRoot(root => {
    const inspected = crashWithLock(root);
    const canonical = missionLockPath(root);
    const base = baseClaim(canonical, inspected.record.token);
    fs.linkSync(canonical, base);

    const recovered = recoverOrResumeStaleMissionLock(root);
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.status, "STALE_RECOVERED");
    assert.equal(recovered.recovery_claim_mode, "movable-owner-v1");
    assert.equal(fs.existsSync(canonical), false);
    assert.equal(fs.existsSync(recovered.quarantine_file), true);

    const evidence = JSON.parse(fs.readFileSync(recovered.quarantine_file, "utf8"));
    assert.equal(evidence.token, inspected.record.token);
    assert.equal(evidence.pid, inspected.record.pid);
  }));

  test("atomically takes over a PID-bearing recovery owner left by a crashed recoverer", () => withRoot(root => {
    const inspected = crashWithLock(root);
    const canonical = missionLockPath(root);
    const base = baseClaim(canonical, inspected.record.token);
    const orphan = ownerClaim(canonical, inspected.record.token, inspected.record.pid, "dead-recoverer");
    fs.linkSync(canonical, base);
    fs.renameSync(base, orphan);

    const recovered = recoverOrResumeStaleMissionLock(root);
    assert.equal(recovered.recovered, true);
    assert.equal(fs.existsSync(canonical), false);
    assert.equal(fs.existsSync(orphan), false);
    assert.equal(fs.existsSync(recovered.quarantine_file), true);
  }));

  test("does not steal a recovery owner whose PID is still alive", () => withRoot(root => {
    const inspected = crashWithLock(root);
    const canonical = missionLockPath(root);
    const base = baseClaim(canonical, inspected.record.token);
    const liveOwner = ownerClaim(canonical, inspected.record.token, process.pid, "live-recoverer");
    fs.linkSync(canonical, base);
    fs.renameSync(base, liveOwner);

    assert.throws(
      () => recoverOrResumeStaleMissionLock(root),
      error => {
        assert.equal(error?.message, "MISSION_CONTROL_LOCK_RECOVERY_ALREADY_CLAIMED");
        assert.equal(error?.recovery_owner_pid, process.pid);
        return true;
      },
    );
    assert.equal(fs.existsSync(canonical), true);
    assert.equal(fs.existsSync(liveOwner), true);
  }));

  test("matching JSON is insufficient when recovery evidence is not the same filesystem object", () => withRoot(root => {
    const inspected = crashWithLock(root);
    const canonical = missionLockPath(root);
    const fakeOwner = ownerClaim(canonical, inspected.record.token, inspected.record.pid, "copied-evidence");
    fs.writeFileSync(fakeOwner, fs.readFileSync(canonical));

    assert.throws(
      () => recoverOrResumeStaleMissionLock(root),
      /MISSION_CONTROL_LOCK_RECOVERY_IDENTITY_MISMATCH/,
    );
    assert.equal(fs.existsSync(canonical), true);
    const current = inspectMissionLock(root);
    assert.equal(current.status, "STALE");
    assert.equal(current.record.token, inspected.record.token);
  }));
}
