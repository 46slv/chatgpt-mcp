import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {inspectMissionLock, missionLockPath} from "./devexec-mission-lock.mjs";

function readLockRecord(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }

  let record;
  try {
    record = JSON.parse(raw);
  } catch (error) {
    const invalid = new Error("MISSION_CONTROL_LOCK_INVALID");
    invalid.cause = error;
    throw invalid;
  }

  if (
    record?.protocol !== "devexec.mission-lock" ||
    record.schema_version !== 1 ||
    typeof record.token !== "string" || !record.token.trim() ||
    typeof record.owner !== "string" || !record.owner.trim() ||
    typeof record.acquired_at !== "string" || !record.acquired_at.trim()
  ) {
    throw new Error("MISSION_CONTROL_LOCK_INVALID");
  }
  return record;
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    const probeError = new Error("MISSION_CONTROL_LOCK_PID_PROBE_FAILED");
    probeError.cause = error;
    throw probeError;
  }
}

function recoveryBasePath(canonical, staleToken) {
  return `${canonical}.stale-${staleToken}.json`;
}

function recoveryOwnerPrefix(canonical, staleToken) {
  return `${path.basename(canonical)}.stale-${staleToken}.recover-`;
}

function recoveryOwnerPath(canonical, staleToken, recoveryPid, recoveryToken) {
  return path.join(
    path.dirname(canonical),
    `${recoveryOwnerPrefix(canonical, staleToken)}${recoveryPid}-${recoveryToken}.json`,
  );
}

function listRecoveryOwnerClaims(canonical, staleToken) {
  const dir = path.dirname(canonical);
  const prefix = recoveryOwnerPrefix(canonical, staleToken);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter(name => name.startsWith(prefix) && name.endsWith(".json"))
    .map(name => path.join(dir, name))
    .sort();
}

function parseRecoveryOwnerClaim(canonical, staleToken, file) {
  const name = path.basename(file);
  const prefix = recoveryOwnerPrefix(canonical, staleToken);
  if (!name.startsWith(prefix) || !name.endsWith(".json")) {
    throw new Error("MISSION_CONTROL_LOCK_RECOVERY_CLAIM_INVALID");
  }
  const body = name.slice(prefix.length, -".json".length);
  const dash = body.indexOf("-");
  if (dash <= 0 || dash === body.length - 1) {
    throw new Error("MISSION_CONTROL_LOCK_RECOVERY_CLAIM_INVALID");
  }
  const pid = Number(body.slice(0, dash));
  const recoveryToken = body.slice(dash + 1);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !recoveryToken.trim()) {
    throw new Error("MISSION_CONTROL_LOCK_RECOVERY_CLAIM_INVALID");
  }
  return {pid, recovery_token: recoveryToken, file};
}

function sameFileIdentity(left, right) {
  const a = fs.statSync(left, {bigint: true});
  const b = fs.statSync(right, {bigint: true});
  if (a.ino === 0n || b.ino === 0n) {
    throw new Error("MISSION_CONTROL_LOCK_FILE_IDENTITY_UNAVAILABLE");
  }
  return a.dev === b.dev && a.ino === b.ino;
}

function restoreOwnedEvidence(ownerFile, baseFile) {
  if (!fs.existsSync(ownerFile)) return ownerFile;
  try {
    fs.linkSync(ownerFile, baseFile);
    fs.rmSync(ownerFile);
    return baseFile;
  } catch (error) {
    if (error?.code === "EEXIST" || fs.existsSync(baseFile)) return ownerFile;
    return ownerFile;
  }
}

function currentStillMatches(inspection, current) {
  return Boolean(
    current &&
    current.token === inspection.record.token &&
    current.pid === inspection.record.pid
  );
}

function claimRecoveryOwnership(inspection) {
  const canonical = inspection.file;
  const staleToken = inspection.record.token;
  const baseFile = recoveryBasePath(canonical, staleToken);
  const recoveryToken = crypto.randomUUID();
  const ownerFile = recoveryOwnerPath(canonical, staleToken, process.pid, recoveryToken);

  for (let attempt = 0; attempt < 12; attempt += 1) {
    let owners = listRecoveryOwnerClaims(canonical, staleToken);
    if (owners.length > 1) {
      const error = new Error("MISSION_CONTROL_LOCK_RECOVERY_MULTIPLE_CLAIMS");
      error.lock_file = canonical;
      error.claim_files = owners;
      throw error;
    }

    if (!fs.existsSync(baseFile) && owners.length === 0) {
      try {
        fs.linkSync(canonical, baseFile);
      } catch (error) {
        if (error?.code === "EEXIST" || fs.existsSync(baseFile)) {
          // Another recoverer published the arbitration link. Compete for the
          // link by rename below rather than assuming ownership.
        } else if (error?.code === "ENOENT") {
          const current = inspectMissionLock(path.dirname(canonical));
          if (current.status === "UNLOCKED") return null;
          const changed = new Error("MISSION_CONTROL_LOCK_CHANGED_DURING_RECOVERY");
          changed.lock_file = canonical;
          changed.lock_status = current.status;
          throw changed;
        } else {
          const claimError = new Error("MISSION_CONTROL_LOCK_RECOVERY_ATOMIC_CLAIM_FAILED");
          claimError.cause = error;
          claimError.lock_file = canonical;
          claimError.quarantine_file = baseFile;
          claimError.fs_code = error?.code ?? null;
          throw claimError;
        }
      }
    }

    if (fs.existsSync(baseFile)) {
      try {
        fs.renameSync(baseFile, ownerFile);
        return {owner_file: ownerFile, base_file: baseFile, recovery_token: recoveryToken};
      } catch (error) {
        if (error?.code !== "ENOENT") {
          const claimError = new Error("MISSION_CONTROL_LOCK_RECOVERY_OWNER_CLAIM_FAILED");
          claimError.cause = error;
          claimError.lock_file = canonical;
          throw claimError;
        }
        continue;
      }
    }

    owners = listRecoveryOwnerClaims(canonical, staleToken);
    if (owners.length > 1) {
      const error = new Error("MISSION_CONTROL_LOCK_RECOVERY_MULTIPLE_CLAIMS");
      error.lock_file = canonical;
      error.claim_files = owners;
      throw error;
    }
    if (owners.length === 1) {
      const existing = parseRecoveryOwnerClaim(canonical, staleToken, owners[0]);
      const alive = processExists(existing.pid);
      if (alive !== false) {
        const claimed = new Error("MISSION_CONTROL_LOCK_RECOVERY_ALREADY_CLAIMED");
        claimed.lock_file = canonical;
        claimed.recovery_owner_pid = existing.pid;
        claimed.quarantine_file = existing.file;
        throw claimed;
      }

      try {
        fs.renameSync(existing.file, ownerFile);
        return {owner_file: ownerFile, base_file: baseFile, recovery_token: recoveryToken};
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        const claimError = new Error("MISSION_CONTROL_LOCK_RECOVERY_OWNER_CLAIM_FAILED");
        claimError.cause = error;
        claimError.lock_file = canonical;
        throw claimError;
      }
    }

    const current = readLockRecord(canonical);
    if (!current) return null;
    if (!currentStillMatches(inspection, current)) {
      const changed = new Error("MISSION_CONTROL_LOCK_CHANGED_DURING_RECOVERY");
      changed.lock_file = canonical;
      throw changed;
    }
  }

  throw new Error("MISSION_CONTROL_LOCK_RECOVERY_CLAIM_RETRY_EXHAUSTED");
}

export function recoverOrResumeStaleMissionLock(missionRoot) {
  const inspection = inspectMissionLock(missionRoot);
  if (inspection.status === "UNLOCKED") {
    return {recovered: false, ...inspection, quarantine_file: null, recovery_claim_mode: "movable-owner-v1"};
  }
  if (inspection.status === "HELD") {
    const error = new Error("MISSION_CONTROL_LOCK_OWNER_ALIVE");
    error.lock_file = inspection.file;
    error.owner_pid = inspection.record?.pid ?? null;
    throw error;
  }
  if (inspection.status !== "STALE" || inspection.recoverable !== true) {
    const error = new Error("MISSION_CONTROL_LOCK_RECOVERY_UNSAFE");
    error.lock_file = inspection.file;
    error.lock_status = inspection.status;
    throw error;
  }

  const ownership = claimRecoveryOwnership(inspection);
  if (!ownership) {
    return {
      recovered: false,
      status: "UNLOCKED_DURING_RECOVERY",
      recoverable: false,
      file: inspection.file,
      record: null,
      quarantine_file: null,
      recovery_claim_mode: "movable-owner-v1",
    };
  }

  let canonicalRemoved = false;
  try {
    const claimed = readLockRecord(ownership.owner_file);
    const current = readLockRecord(inspection.file);
    if (!currentStillMatches(inspection, claimed) || !currentStillMatches(inspection, current)) {
      const changed = new Error("MISSION_CONTROL_LOCK_CHANGED_DURING_RECOVERY");
      changed.lock_file = inspection.file;
      throw changed;
    }

    if (processExists(inspection.record.pid) !== false) {
      const alive = new Error("MISSION_CONTROL_LOCK_OWNER_ALIVE");
      alive.lock_file = inspection.file;
      alive.owner_pid = inspection.record.pid;
      throw alive;
    }

    if (!sameFileIdentity(ownership.owner_file, inspection.file)) {
      const mismatch = new Error("MISSION_CONTROL_LOCK_RECOVERY_IDENTITY_MISMATCH");
      mismatch.lock_file = inspection.file;
      mismatch.quarantine_file = ownership.owner_file;
      throw mismatch;
    }

    // Only the process owning the movable recovery link can reach this unlink.
    // A crashed owner leaves its owner PID in the claim filename; a successor
    // must atomically rename that exact claim before it can continue. Therefore
    // two compliant recoverers cannot both pass this boundary against one
    // canonical pathname.
    fs.rmSync(inspection.file);
    canonicalRemoved = true;

    const quarantineFile = restoreOwnedEvidence(ownership.owner_file, ownership.base_file);
    return {
      recovered: true,
      status: "STALE_RECOVERED",
      recoverable: false,
      file: inspection.file,
      record: inspection.record,
      quarantine_file: quarantineFile,
      recovery_claim_mode: "movable-owner-v1",
    };
  } finally {
    if (!canonicalRemoved) {
      // Controlled validation failures release only this recovery ownership
      // link back to the neutral evidence name. A process crash skips this
      // finally; its PID-bearing owner filename then becomes the resumable
      // durable handoff for the next process.
      restoreOwnedEvidence(ownership.owner_file, ownership.base_file);
    }
  }
}
