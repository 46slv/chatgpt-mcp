import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function missionLockPath(missionRoot) {
  if (typeof missionRoot !== "string" || !missionRoot.trim()) throw new Error("mission root required");
  return path.join(path.resolve(missionRoot), "mission-control.lock");
}

function readMissionLockRecord(file) {
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

export function inspectMissionLock(missionRoot) {
  const file = missionLockPath(missionRoot);
  let record;
  try {
    record = readMissionLockRecord(file);
  } catch (error) {
    return {
      status: "INVALID",
      recoverable: false,
      file,
      record: null,
      error: error?.message || String(error),
    };
  }
  if (!record) {
    return {status: "UNLOCKED", recoverable: false, file, record: null};
  }

  if (!Number.isSafeInteger(record.pid) || record.pid <= 0) {
    return {status: "UNKNOWN_OWNER", recoverable: false, file, record};
  }

  try {
    const alive = processExists(record.pid);
    return {
      status: alive ? "HELD" : "STALE",
      recoverable: alive === false,
      file,
      record,
    };
  } catch (error) {
    return {
      status: "PROBE_FAILED",
      recoverable: false,
      file,
      record,
      error: error?.message || String(error),
    };
  }
}

export function recoverStaleMissionLock(missionRoot) {
  const inspection = inspectMissionLock(missionRoot);
  if (inspection.status === "UNLOCKED") {
    return {recovered: false, ...inspection, quarantine_file: null};
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

  // Recovery itself needs an atomic ownership claim. A plain
  // read/compare/rename sequence allows two recoverers to validate the same
  // stale record; after the first frees the canonical path, the second rename
  // could target a replacement lock. Create a deterministic hard-link evidence
  // path first. Only one recoverer can create it, and after canonical unlink
  // this recoverer never touches the canonical path again.
  const quarantineFile = `${inspection.file}.stale-${inspection.record.token}.json`;
  try {
    fs.linkSync(inspection.file, quarantineFile);
  } catch (error) {
    if (error?.code === "EEXIST" || fs.existsSync(quarantineFile)) {
      const claimed = new Error("MISSION_CONTROL_LOCK_RECOVERY_ALREADY_CLAIMED");
      claimed.lock_file = inspection.file;
      claimed.quarantine_file = quarantineFile;
      throw claimed;
    }
    if (error?.code === "ENOENT") {
      const current = inspectMissionLock(missionRoot);
      if (current.status === "UNLOCKED") {
        return {recovered: false, ...current, quarantine_file: null};
      }
      const changed = new Error("MISSION_CONTROL_LOCK_CHANGED_DURING_RECOVERY");
      changed.lock_file = inspection.file;
      changed.lock_status = current.status;
      throw changed;
    }
    const claimError = new Error("MISSION_CONTROL_LOCK_RECOVERY_ATOMIC_CLAIM_FAILED");
    claimError.cause = error;
    claimError.lock_file = inspection.file;
    claimError.quarantine_file = quarantineFile;
    claimError.fs_code = error?.code ?? null;
    throw claimError;
  }

  let keepQuarantine = false;
  try {
    const claimed = readMissionLockRecord(quarantineFile);
    const current = readMissionLockRecord(inspection.file);
    if (
      !current ||
      claimed?.token !== inspection.record.token ||
      claimed?.pid !== inspection.record.pid ||
      current.token !== inspection.record.token ||
      current.pid !== inspection.record.pid
    ) {
      const changed = new Error("MISSION_CONTROL_LOCK_CHANGED_DURING_RECOVERY");
      changed.lock_file = inspection.file;
      throw changed;
    }

    // The quarantine hard link pins exactly the stale inode we validated. Once
    // the canonical name is unlinked, a new owner may safely publish there; this
    // recovery path must never rename/remove the canonical path again.
    fs.rmSync(inspection.file);
    keepQuarantine = true;
    return {
      recovered: true,
      status: "STALE_RECOVERED",
      recoverable: false,
      file: inspection.file,
      record: inspection.record,
      quarantine_file: quarantineFile,
    };
  } finally {
    // If verification or canonical unlink failed, remove only the claim created
    // by this call. Never weaken or replace the canonical lock on an error path.
    if (!keepQuarantine) {
      try { fs.rmSync(quarantineFile, {force: true}); } catch {}
    }
  }
}

function stagingLockPath(file, pid, token) {
  return `${file}.claim-${pid}-${token}.tmp`;
}

export function acquireMissionLock(missionRoot, {
  owner = `pid:${process.pid}`,
  now = new Date().toISOString(),
} = {}) {
  const file = missionLockPath(missionRoot);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const token = crypto.randomUUID();
  const stagingFile = stagingLockPath(file, process.pid, token);
  const record = {
    protocol: "devexec.mission-lock",
    schema_version: 1,
    token,
    owner,
    pid: process.pid,
    acquired_at: now,
    publication: "hardlink-v1",
  };

  // Never expose the canonical lock path before its owner record is complete.
  // The old open(file, "wx") -> write -> fsync sequence had a process-crash
  // window where an empty/partial canonical file could permanently fail closed.
  // Here the record is written and fsynced under a unique staging name first,
  // then atomically published with linkSync(), which fails rather than replacing
  // an existing canonical lock.
  let stagingFd;
  try {
    stagingFd = fs.openSync(stagingFile, "wx", 0o600);
    fs.writeFileSync(stagingFd, JSON.stringify(record, null, 2) + "\n", "utf8");
    fs.fsyncSync(stagingFd);
    fs.closeSync(stagingFd);
    stagingFd = null;
  } catch (error) {
    if (stagingFd != null) {
      try { fs.closeSync(stagingFd); } catch {}
    }
    try { fs.rmSync(stagingFile, {force: true}); } catch {}
    throw error;
  }

  try {
    fs.linkSync(stagingFile, file);
  } catch (error) {
    try { fs.rmSync(stagingFile, {force: true}); } catch {}
    // Some Windows/filesystem combinations can surface a non-EEXIST error for
    // an already-present target. If the canonical lock exists after the failed
    // link attempt, conservatively classify it as contention and never replace it.
    if (error?.code === "EEXIST" || fs.existsSync(file)) {
      const locked = new Error("MISSION_CONTROL_LOCKED");
      locked.lock_file = file;
      throw locked;
    }
    const publishError = new Error("MISSION_CONTROL_LOCK_ATOMIC_PUBLISH_FAILED");
    publishError.cause = error;
    publishError.lock_file = file;
    publishError.fs_code = error?.code ?? null;
    throw publishError;
  }

  // Publication already succeeded. Staging cleanup is deliberately best-effort:
  // throwing after linkSync() would tell the caller acquisition failed while a
  // valid canonical lock actually exists. A crash here can leave a harmless
  // non-canonical staging alias; the canonical lock remains parseable/recoverable.
  try { fs.rmSync(stagingFile, {force: true}); } catch {}

  let released = false;
  return {
    file,
    token,
    owner,
    pid: process.pid,
    release() {
      if (released) return false;
      released = true;

      let current;
      try {
        current = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (error) {
        const lost = new Error("MISSION_CONTROL_LOCK_OWNERSHIP_LOST");
        lost.cause = error;
        throw lost;
      }
      if (current?.token !== token || current?.pid !== process.pid) {
        throw new Error("MISSION_CONTROL_LOCK_OWNERSHIP_LOST");
      }
      fs.rmSync(file);
      return true;
    },
  };
}

export function withMissionLock(missionRoot, fn, options = {}) {
  if (typeof fn !== "function") throw new Error("mission lock callback required");
  const lock = acquireMissionLock(missionRoot, options);
  let callbackError = null;
  try {
    const result = fn(lock);
    if (result && typeof result.then === "function") {
      throw new Error("MISSION_LOCK_ASYNC_CALLBACK_UNSUPPORTED");
    }
    return result;
  } catch (error) {
    callbackError = error;
    throw error;
  } finally {
    try {
      lock.release();
    } catch (releaseError) {
      if (!callbackError) throw releaseError;
    }
  }
}
