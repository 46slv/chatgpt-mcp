import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const MISSION_TRANSITION_LOCK_PROTOCOL = "devexec.mission-transition-lock";
export const MISSION_TRANSITION_LOCK_SCHEMA_VERSION = 1;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 10;
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

export class MissionTransitionLockError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = "MissionTransitionLockError";
    this.code = code;
  }
}

function digestMissionId(missionId) {
  return crypto.createHash("sha256").update(String(missionId), "utf8").digest("hex");
}

function monotonicMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function sleepMs(ms) {
  if (ms > 0) Atomics.wait(SLEEP_CELL, 0, 0, ms);
}

function ensureSafeDirectory(directory, label, { recursive = true } = {}) {
  try {
    fs.mkdirSync(directory, { recursive, mode: 0o700 });
  } catch (error) {
    if (!(error?.code === "EEXIST" && !recursive)) throw error;
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink?.() || stat.isReparsePoint?.()) {
    throw new MissionTransitionLockError("MISSION_TRANSITION_LOCK_UNSAFE", `${label} is not a private directory`);
  }
  return stat;
}

function validateOwner(value, expectedKey = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MissionTransitionLockError("MISSION_TRANSITION_LOCK_CORRUPT", "transition lock owner metadata is invalid");
  }
  const keys = Object.keys(value).sort();
  const wanted = ["acquired_at", "mission_key", "nonce", "owner_pid", "protocol", "schema_version"].sort();
  if (keys.length !== wanted.length || wanted.some((key, index) => key !== keys[index])) {
    throw new MissionTransitionLockError("MISSION_TRANSITION_LOCK_CORRUPT", "transition lock owner metadata has unknown or missing fields");
  }
  if (value.protocol !== MISSION_TRANSITION_LOCK_PROTOCOL || value.schema_version !== MISSION_TRANSITION_LOCK_SCHEMA_VERSION) {
    throw new MissionTransitionLockError("MISSION_TRANSITION_LOCK_CORRUPT", "transition lock owner metadata schema is unsupported");
  }
  if (typeof value.mission_key !== "string" || !/^[a-f0-9]{64}$/.test(value.mission_key)) {
    throw new MissionTransitionLockError("MISSION_TRANSITION_LOCK_CORRUPT", "transition lock mission key is invalid");
  }
  if (expectedKey !== null && value.mission_key !== expectedKey) {
    throw new MissionTransitionLockError("MISSION_TRANSITION_LOCK_CORRUPT", "transition lock mission key does not match its path");
  }
  if (!Number.isInteger(value.owner_pid) || value.owner_pid <= 0) {
    throw new MissionTransitionLockError("MISSION_TRANSITION_LOCK_CORRUPT", "transition lock owner pid is invalid");
  }
  if (typeof value.nonce !== "string" || !/^[a-f0-9]{32}$/.test(value.nonce)) {
    throw new MissionTransitionLockError("MISSION_TRANSITION_LOCK_CORRUPT", "transition lock nonce is invalid");
  }
  if (typeof value.acquired_at !== "string" || !Number.isFinite(Date.parse(value.acquired_at))) {
    throw new MissionTransitionLockError("MISSION_TRANSITION_LOCK_CORRUPT", "transition lock acquisition timestamp is invalid");
  }
  return value;
}

function readOwner(ownerFile, missionKey) {
  const stat = fs.lstatSync(ownerFile);
  if (!stat.isFile() || stat.isSymbolicLink?.() || stat.isReparsePoint?.() || (Number.isInteger(stat.nlink) && stat.nlink !== 1)) {
    throw new MissionTransitionLockError("MISSION_TRANSITION_LOCK_CORRUPT", "transition lock owner metadata is not a private regular file");
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
  } catch (error) {
    throw new MissionTransitionLockError("MISSION_TRANSITION_LOCK_CORRUPT", "transition lock owner metadata is unreadable", { cause: error });
  }
  return validateOwner(parsed, missionKey);
}

function writeOwner(ownerFile, owner) {
  let fd;
  try {
    fd = fs.openSync(ownerFile, "wx", 0o600);
    const bytes = Buffer.from(`${JSON.stringify(owner)}\n`, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
      if (!Number.isInteger(written) || written <= 0) {
        throw new MissionTransitionLockError("MISSION_TRANSITION_LOCK_IO", "transition lock owner write made no progress");
      }
      offset += written;
    }
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function cleanupFailedAcquire(lockPath, ownerFile) {
  try { if (fs.existsSync(ownerFile)) fs.unlinkSync(ownerFile); } catch { /* fail closed at caller */ }
  try { if (fs.existsSync(lockPath)) fs.rmdirSync(lockPath); } catch { /* fail closed at caller */ }
}

export function inspectMissionTransitionLock({ stateDir, missionId } = {}) {
  if (typeof stateDir !== "string" || !stateDir.trim()) {
    throw new MissionTransitionLockError("MISSION_TRANSITION_LOCK_STATE_DIR_REQUIRED", "stateDir is required");
  }
  const root = path.join(path.resolve(stateDir), "mission-transition-locks");
  const missionKey = digestMissionId(missionId);
  const lockPath = path.join(root, `${missionKey}.lock`);
  const ownerFile = path.join(lockPath, "owner.json");
  if (!fs.existsSync(lockPath)) return null;
  const stat = fs.lstatSync(lockPath);
  if (!stat.isDirectory() || stat.isSymbolicLink?.() || stat.isReparsePoint?.()) {
    throw new MissionTransitionLockError("MISSION_TRANSITION_LOCK_UNSAFE", "transition lock path is unsafe");
  }
  return { lock_path: lockPath, owner: { ...readOwner(ownerFile, missionKey) } };
}

export function acquireMissionTransitionLock({
  stateDir,
  missionId,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
} = {}) {
  if (typeof stateDir !== "string" || !stateDir.trim()) {
    throw new MissionTransitionLockError("MISSION_TRANSITION_LOCK_STATE_DIR_REQUIRED", "stateDir is required");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 300_000) {
    throw new MissionTransitionLockError("MISSION_TRANSITION_LOCK_OPTIONS_INVALID", "timeoutMs is invalid");
  }
  if (!Number.isInteger(pollMs) || pollMs < 1 || pollMs > 1000) {
    throw new MissionTransitionLockError("MISSION_TRANSITION_LOCK_OPTIONS_INVALID", "pollMs is invalid");
  }

  const root = path.join(path.resolve(stateDir), "mission-transition-locks");
  ensureSafeDirectory(root, "transition lock root");
  const missionKey = digestMissionId(missionId);
  const lockPath = path.join(root, `${missionKey}.lock`);
  const ownerFile = path.join(lockPath, "owner.json");
  const started = monotonicMs();

  while (true) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const stat = fs.lstatSync(lockPath);
      if (!stat.isDirectory() || stat.isSymbolicLink?.() || stat.isReparsePoint?.()) {
        throw new MissionTransitionLockError("MISSION_TRANSITION_LOCK_UNSAFE", "transition lock path is unsafe");
      }
      // Existing locks are never auto-broken. A crash therefore remains
      // fail-closed until an operator explicitly adjudicates the residue.
      if (monotonicMs() - started >= timeoutMs) {
        let owner = null;
        try { owner = readOwner(ownerFile, missionKey); } catch { /* corruption is inspectable separately */ }
        throw new MissionTransitionLockError(
          "MISSION_TRANSITION_BUSY",
          `Mission transition lock is already held${owner ? ` by pid ${owner.owner_pid}` : ""}`,
        );
      }
      sleepMs(Math.min(pollMs, Math.max(1, timeoutMs - (monotonicMs() - started))));
    }
  }

  const nonce = crypto.randomBytes(16).toString("hex");
  const owner = {
    protocol: MISSION_TRANSITION_LOCK_PROTOCOL,
    schema_version: MISSION_TRANSITION_LOCK_SCHEMA_VERSION,
    mission_key: missionKey,
    owner_pid: process.pid,
    acquired_at: new Date().toISOString(),
    nonce,
  };

  try {
    const lockStat = fs.lstatSync(lockPath);
    if (!lockStat.isDirectory() || lockStat.isSymbolicLink?.() || lockStat.isReparsePoint?.()) {
      throw new MissionTransitionLockError("MISSION_TRANSITION_LOCK_UNSAFE", "transition lock path changed during acquisition");
    }
    writeOwner(ownerFile, owner);
  } catch (error) {
    cleanupFailedAcquire(lockPath, ownerFile);
    if (error instanceof MissionTransitionLockError) throw error;
    throw new MissionTransitionLockError("MISSION_TRANSITION_LOCK_IO", "failed to publish transition lock owner metadata", { cause: error });
  }

  let released = false;
  return {
    mission_key: missionKey,
    lock_path: lockPath,
    owner: { ...owner },
    release() {
      if (released) return;
      try {
        const lockStat = fs.lstatSync(lockPath);
        if (!lockStat.isDirectory() || lockStat.isSymbolicLink?.() || lockStat.isReparsePoint?.()) {
          throw new MissionTransitionLockError("MISSION_TRANSITION_LOCK_REPLACED", "transition lock path changed before release");
        }
        const observed = readOwner(ownerFile, missionKey);
        if (observed.nonce !== nonce || observed.owner_pid !== process.pid) {
          throw new MissionTransitionLockError("MISSION_TRANSITION_LOCK_REPLACED", "transition lock ownership changed before release");
        }
        fs.unlinkSync(ownerFile);
        fs.rmdirSync(lockPath);
        released = true;
      } catch (error) {
        if (error instanceof MissionTransitionLockError) throw error;
        throw new MissionTransitionLockError("MISSION_TRANSITION_RELEASE_AMBIGUOUS", "transition lock release could not be proven", { cause: error });
      }
    },
  };
}

export function withMissionTransitionLock(options, operation) {
  if (typeof operation !== "function") {
    throw new MissionTransitionLockError("MISSION_TRANSITION_LOCK_OPTIONS_INVALID", "operation must be a function");
  }
  const lock = acquireMissionTransitionLock(options);
  let value;
  let operationError = null;
  try {
    value = operation();
    if (value && typeof value.then === "function") {
      throw new MissionTransitionLockError("MISSION_TRANSITION_ASYNC_UNSUPPORTED", "mission transition operation must be synchronous");
    }
  } catch (error) {
    operationError = error;
  }

  try {
    lock.release();
  } catch (releaseError) {
    if (operationError) {
      throw new MissionTransitionLockError(
        "MISSION_TRANSITION_RELEASE_AMBIGUOUS",
        "mission transition failed and lock release could not be proven",
        { cause: operationError },
      );
    }
    throw releaseError;
  }

  if (operationError) throw operationError;
  return value;
}
