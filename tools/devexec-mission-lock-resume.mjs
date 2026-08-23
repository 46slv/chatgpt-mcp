import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {inspectMissionLock} from "./devexec-mission-lock.mjs";

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

function mixedClaimsError(canonical, baseFile, owners) {
  const error = new Error("MISSION_CONTROL_LOCK_RECOVERY_MIXED_CLAIMS");
  error.lock_file = canonical;
  error.quarantine_file = baseFile;
  error.claim_files = owners;
  return error;
}

function multipleClaimsError(canonical, owners) {
  const error = new Error("MISSION_CONTROL_LOCK_RECOVERY_MULTIPLE_CLAIMS");
  error.lock_file = canonical;
  error.claim_files = owners;
  return error;
}

function claimRecoveryOwnership(inspection) {
  const canonical = inspection.file;
  const staleToken = inspection.record.token;
  const baseFile = recoveryBasePath(canonical, staleToken);
  const recoveryToken = crypto.randomUUID();
  const ownerFile = recoveryOwnerPath(canonical, staleToken, process.pid, recoveryToken);

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const owners = listRecoveryOwnerClaims(canonical, staleToken);
    const baseExists = fs.existsSync(baseFile);

    if (owners.length > 1) throw multipleClaimsError(canonical, owners);

    // Classify the entire recovery namespace before mutating it. A live/dead
    // PID-bearing owner plus neutral evidence is an ambiguous mixed-protocol
    // state. Never consume the neutral path while another recovery owner exists.
    if (owners.length === 1 && baseExists) {
      throw mixedClaimsError(canonical, baseFile, owners);
    }

    // Owner claims always take precedence over neutral evidence. This is the
    // only path that can resume a crashed recoverer.
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

    if (baseExists) {
      try {
        fs.renameSync(baseFile, ownerFile);
        return {owner_file: ownerFile, base_file: baseFile, recovery_token: recoveryToken};
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        const claimError = new Error("MISSION_CONTROL_LOCK_RECOVERY_OWNER_CLAIM_FAILED");
        claimError.cause = error;
        claimError.lock_file = canonical;
        throw claimError;
      }
    }

    try {
      fs.linkSync(canonical, baseFile);
      // Reclassify on the next iteration. If another owner appeared while the
      // neutral link was published, mixed-state detection fails closed before
      // any ownership transition or canonical unlink.
      continue;
    } catch (error) {
      if (error?.code === "EEXIST" || fs.existsSync(baseFile)) continue;
      if (error?.code === "ENOENT") {
        const current = inspectMissionLock(path.dirname(canonical));
        if (current.status === "UNLOCKED") return null;
        const changed = new Error("MISSION_CONTROL_LOCK_CHANGED_DURING_RECOVERY");
        changed.lock_file = canonical;
        changed.lock_status = current.status;
        throw changed;
      }
      const claimError = new Error("MISSION_CONTROL_LOCK_RECOVERY_ATOMIC_CLAIM_FAILED");
      claimError.cause = error;
      claimError.lock_file = canonical;
      claimError.quarantine_file = baseFile;
      claimError.fs_code = error?.code ?? null;
      throw claimError;
    }
  }

  throw new Error("MISSION_CONTROL_LOCK_RECOVERY_CLAIM_RETRY_EXHAUSTED");
}

function assertExclusiveRecoveryOwnership(inspection, ownership) {
  const canonical = inspection.file;
  const staleToken = inspection.record.token;
  const owners = listRecoveryOwnerClaims(canonical, staleToken);
  const foreignOwners = owners.filter(file => path.resolve(file) !== path.resolve(ownership.owner_file));
  const baseExists = fs.existsSync(ownership.base_file);

  if (foreignOwners.length > 0 || baseExists) {
    throw mixedClaimsError(canonical, ownership.base_file, owners);
  }
  if (owners.length !== 1 || path.resolve(owners[0]) !== path.resolve(ownership.owner_file)) {
    const error = new Error("MISSION_CONTROL_LOCK_RECOVERY_OWNERSHIP_LOST");
    error.lock_file = canonical;
    error.claim_files = owners;
    throw error;
  }
}

export function recoverOrResumeStaleMissionLock(missionRoot) {
  const inspection = inspectMissionLock(missionRoot);
  if (inspection.status === "UNLOCKED") {
    return {recovered: false, ...inspection, quarantine_file: null, recovery_claim_mode: "movable-owner-v2"};
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
      recovery_claim_mode: "movable-owner-v2",
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

    // Re-read the recovery namespace immediately before the only canonical
    // mutation. Any foreign owner or neutral claim means arbitration is no
    // longer exclusive, so preserve the canonical lock and fail closed.
    assertExclusiveRecoveryOwnership(inspection, ownership);

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
      recovery_claim_mode: "movable-owner-v2",
    };
  } finally {
    if (!canonicalRemoved) {
      restoreOwnedEvidence(ownership.owner_file, ownership.base_file);
    }
  }
}
