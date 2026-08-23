import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  inspectMissionLock,
  missionLockPath,
  recoverStaleMissionLock,
} from "./devexec-mission-lock.mjs";
import {recoverOrResumeStaleMissionLock} from "./devexec-mission-lock-resume.mjs";

function makeStaleLock(root) {
  fs.mkdirSync(root, {recursive: true});
  const file = missionLockPath(root);
  const token = crypto.randomUUID();
  const record = {
    protocol: "devexec.mission-lock",
    schema_version: 1,
    token,
    owner: "interlock-probe:dead-owner",
    pid: 2147483000,
    acquired_at: new Date().toISOString(),
    publication: "probe",
  };
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n", "utf8");
  const inspection = inspectMissionLock(root);
  if (inspection.status !== "STALE" || inspection.recoverable !== true) {
    throw new Error(`probe requires a definitely absent PID; observed ${inspection.status}`);
  }
  return {file, token, record};
}

function neutralClaim(file, token) {
  return `${file}.stale-${token}.json`;
}

function liveOwnerClaim(file, token, label) {
  return `${file}.stale-${token}.recover-${process.pid}-${label}.json`;
}

function withRoot(name, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `devexec-recovery-interlock-${name}-`));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
}

const results = [];

// Mixed state: a live movable owner exists, but a neutral arbitration link is
// also present. claimRecoveryOwnership() currently consumes the neutral link
// before checking the live owner claim, so the live-owner fence can be bypassed.
results.push(withRoot("movable", root => {
  const stale = makeStaleLock(root);
  const neutral = neutralClaim(stale.file, stale.token);
  const liveOwner = liveOwnerClaim(stale.file, stale.token, "live-owner-bypass");
  fs.linkSync(stale.file, liveOwner);
  fs.linkSync(stale.file, neutral);

  let error = null;
  try {
    recoverOrResumeStaleMissionLock(root);
  } catch (caught) {
    error = caught;
  }

  return {
    case: "movable_owner_plus_neutral",
    expected_after_repair: "fail closed while a live movable owner exists",
    current_error: error?.message ?? null,
    canonical_exists: fs.existsSync(stale.file),
    live_owner_exists: fs.existsSync(liveOwner),
    neutral_exists: fs.existsSync(neutral),
    bug_reproduced: error == null && !fs.existsSync(stale.file),
  };
}));

// Cross-protocol state: the movable protocol owns the recovery via a live
// PID-bearing hard link. The older exported recoverStaleMissionLock() does not
// inspect movable-owner claims, recreates the neutral link, and can remove the
// canonical stale lock underneath that live owner.
results.push(withRoot("legacy", root => {
  const stale = makeStaleLock(root);
  const liveOwner = liveOwnerClaim(stale.file, stale.token, "legacy-bypass");
  fs.linkSync(stale.file, liveOwner);

  let error = null;
  try {
    recoverStaleMissionLock(root);
  } catch (caught) {
    error = caught;
  }

  return {
    case: "legacy_recovery_vs_movable_owner",
    expected_after_repair: "recovery protocols share one arbitration domain",
    current_error: error?.message ?? null,
    canonical_exists: fs.existsSync(stale.file),
    live_owner_exists: fs.existsSync(liveOwner),
    bug_reproduced: error == null && !fs.existsSync(stale.file),
  };
}));

for (const result of results) {
  console.log(JSON.stringify(result));
}

if (!results.every(result => result.bug_reproduced === true)) {
  console.error("MIXED_RECOVERY_INTERLOCK_PROBE=NOT_REPRODUCED");
  process.exitCode = 2;
} else {
  console.log("MIXED_RECOVERY_INTERLOCK_PROBE=REPRODUCED");
}
