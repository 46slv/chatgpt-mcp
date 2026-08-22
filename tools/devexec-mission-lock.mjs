import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function missionLockPath(missionRoot) {
  if (typeof missionRoot !== "string" || !missionRoot.trim()) throw new Error("mission root required");
  return path.join(path.resolve(missionRoot), "mission-control.lock");
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
    return fn(lock);
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
