import assert from "node:assert/strict";
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
    owner: "interlock-regression:dead-owner",
    pid: 2147483000,
    acquired_at: new Date().toISOString(),
    publication: "regression",
  };
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n", "utf8");
  const inspection = inspectMissionLock(root);
  assert.equal(inspection.status, "STALE");
  assert.equal(inspection.recoverable, true);
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

results.push(withRoot("movable", root => {
  const stale = makeStaleLock(root);
  const neutral = neutralClaim(stale.file, stale.token);
  const liveOwner = liveOwnerClaim(stale.file, stale.token, "live-owner");
  fs.linkSync(stale.file, liveOwner);
  fs.linkSync(stale.file, neutral);

  let error = null;
  try {
    recoverOrResumeStaleMissionLock(root);
  } catch (caught) {
    error = caught;
  }

  assert.equal(error?.message, "MISSION_CONTROL_LOCK_RECOVERY_MIXED_CLAIMS");
  assert.equal(fs.existsSync(stale.file), true);
  assert.equal(fs.existsSync(liveOwner), true);
  assert.equal(fs.existsSync(neutral), true);
  return {case: "movable_owner_plus_neutral", error: error.message, canonical_intact: true};
}));

results.push(withRoot("legacy", root => {
  const stale = makeStaleLock(root);
  const liveOwner = liveOwnerClaim(stale.file, stale.token, "legacy-blocked");
  fs.linkSync(stale.file, liveOwner);

  let error = null;
  try {
    recoverStaleMissionLock(root);
  } catch (caught) {
    error = caught;
  }

  assert.equal(error?.message, "MISSION_CONTROL_LOCK_RECOVERY_LEGACY_MUTATOR_RETIRED");
  assert.equal(fs.existsSync(stale.file), true);
  assert.equal(fs.existsSync(liveOwner), true);
  return {case: "legacy_mutator_retired", error: error.message, canonical_intact: true};
}));

for (const result of results) console.log(JSON.stringify(result));
console.log("MIXED_RECOVERY_INTERLOCK_REGRESSION=PASS");
