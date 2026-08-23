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

  // The lock file itself still excludes new acquirers while we verify that the
  // exact dead-owner record we inspected is the one being quarantined. If a
  // concurrent recovery replaced/removed it, fail closed rather than touching
  // a newer owner's lock.
  const current = readMissionLockRecord(inspection.file);
  if (!current) {
    return {
      recovered: false,
      status: "UNLOCKED",
      recoverable: false,
      file: inspection.file,
      record: null,
      quarantine_file: null,
    };
  }
  if (current.token !== inspection.record.token || current.pid !== inspection.record.pid) {
    const error = new Error("MISSION_CONTROL_LOCK_CHANGED_DURING_RECOVERY");
    error.lock_file = inspection.file;
    throw error;
  }

  // Preserve the stale lock as evidence instead of deleting it. Renaming within
  // the Mission directory atomically frees the canonical lock path for a later
  // explicit acquire while retaining the dead owner's token/pid/timestamp.
  const quarantineFile = `${inspection.file}.stale-${inspection.record.token}.json`;
  fs.renameSync(inspection.file, quarantineFile);
  return {
    recovered: true,
    status: "STALE_RECOVERED",
    recoverable: false,
    file: inspection.file,
    record: inspection.record,
    quarantine_file: quarantineFile,
  };
}

export function acquireMissionLock(missionRoot, {
  owner = `pid:${process.pid}`,
  now = new Date().toISOString(),
} = {}) {
  const file = missionLockPath(missionRoot);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const token = crypto.randomUUID();
  let fd;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      const locked = new Error("MISSION_CONTROL_LOCKED");
      locked.lock_file = file;
      throw locked;
    }
    throw error;
  }

  try {
    fs.writeFileSync(fd, JSON.stringify({
      protocol: "devexec.mission-lock",
      schema_version: 1,
      token,
      owner,
      pid: process.pid,
      acquired_at: now,
    }, null, 2) + "\n", "utf8");
    fs.fsyncSync(fd);
  } catch (error) {
    try { fs.closeSync(fd); } catch {}
    try { fs.rmSync(file, {force: true}); } catch {}
    throw error;
  }

  let released = false;
  return {
    file,
    token,
    owner,
    pid: process.pid,
    release() {
      if (released) return false;
      released = true;
      fs.closeSync(fd);

      let current;
      try {
        current = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (error) {
        const lost = new Error("MISSION_CONTROL_LOCK_OWNERSHIP_LOST");
        lost.cause = error;
        throw lost;
      }
      if (current?.token !== token) throw new Error("MISSION_CONTROL_LOCK_OWNERSHIP_LOST");
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
