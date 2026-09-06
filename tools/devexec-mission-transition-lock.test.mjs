import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  MissionTransitionLockError,
  acquireMissionTransitionLock,
  inspectMissionTransitionLock,
  withMissionTransitionLock,
} from "./devexec-mission-transition-lock.mjs";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-lock-"));
}

test("same Mission is exclusive and different Missions remain independent", () => {
  const root = tmp();
  const held = acquireMissionTransitionLock({ stateDir: root, missionId: "mission-a", timeoutMs: 0 });
  assert.throws(
    () => acquireMissionTransitionLock({ stateDir: root, missionId: "mission-a", timeoutMs: 0 }),
    (error) => error instanceof MissionTransitionLockError && error.code === "MISSION_TRANSITION_BUSY",
  );
  const other = acquireMissionTransitionLock({ stateDir: root, missionId: "mission-b", timeoutMs: 0 });
  other.release();
  held.release();
  assert.equal(inspectMissionTransitionLock({ stateDir: root, missionId: "mission-a" }), null);
});

test("mission identity is path-safe and not exposed in lock filenames", () => {
  const root = tmp();
  const held = acquireMissionTransitionLock({ stateDir: root, missionId: "../../unsafe\\mission", timeoutMs: 0 });
  assert.match(path.basename(held.lock_path), /^[a-f0-9]{64}\.lock$/);
  assert.equal(held.lock_path.startsWith(path.join(root, "mission-transition-locks") + path.sep), true);
  held.release();
});

test("cross-process acquisition fails closed while owner is live", () => {
  const root = tmp();
  const held = acquireMissionTransitionLock({ stateDir: root, missionId: "mission-cross", timeoutMs: 0 });
  const moduleUrl = new URL("./devexec-mission-transition-lock.mjs", import.meta.url).href;
  const script = `import { acquireMissionTransitionLock } from ${JSON.stringify(moduleUrl)};\ntry { acquireMissionTransitionLock({stateDir: process.env.ROOT, missionId: 'mission-cross', timeoutMs: 30, pollMs: 5}); process.exit(2); } catch (e) { if (e.code !== 'MISSION_TRANSITION_BUSY') { console.error(e); process.exit(3); } }`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, ROOT: root },
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  held.release();
});

test("crash residue is inspectable and never auto-broken", () => {
  const root = tmp();
  const moduleUrl = new URL("./devexec-mission-transition-lock.mjs", import.meta.url).href;
  const script = `import { acquireMissionTransitionLock } from ${JSON.stringify(moduleUrl)}; acquireMissionTransitionLock({stateDir: process.env.ROOT, missionId: 'mission-crash', timeoutMs: 0}); process.exit(0);`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, ROOT: root },
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  const observed = inspectMissionTransitionLock({ stateDir: root, missionId: "mission-crash" });
  assert.equal(observed.owner.owner_pid, child.pid);
  assert.throws(
    () => acquireMissionTransitionLock({ stateDir: root, missionId: "mission-crash", timeoutMs: 20, pollMs: 5 }),
    (error) => error instanceof MissionTransitionLockError && error.code === "MISSION_TRANSITION_BUSY",
  );
});

test("ownerless crash window remains inspectable and fail-closed", () => {
  const root = tmp();
  const held = acquireMissionTransitionLock({ stateDir: root, missionId: "mission-ownerless", timeoutMs: 0 });
  const lockPath = held.lock_path;
  held.release();

  // Simulate a process dying after mkdir(lockPath) wins the mutex but before
  // owner.json is published. This residue must remain visible and must not be
  // auto-broken by another acquisition attempt.
  fs.mkdirSync(lockPath, { mode: 0o700 });
  const observed = inspectMissionTransitionLock({ stateDir: root, missionId: "mission-ownerless" });
  assert.equal(observed.lock_path, lockPath);
  assert.equal(observed.owner, null);
  assert.throws(
    () => acquireMissionTransitionLock({ stateDir: root, missionId: "mission-ownerless", timeoutMs: 0 }),
    (error) => error instanceof MissionTransitionLockError && error.code === "MISSION_TRANSITION_BUSY",
  );
});

test("owner metadata replacement is never unlinked by the original owner", () => {
  const root = tmp();
  const held = acquireMissionTransitionLock({ stateDir: root, missionId: "mission-replaced", timeoutMs: 0 });
  const ownerFile = path.join(held.lock_path, "owner.json");
  const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
  fs.writeFileSync(ownerFile, `${JSON.stringify({ ...owner, nonce: "f".repeat(32) })}\n`, "utf8");
  assert.throws(
    () => held.release(),
    (error) => error instanceof MissionTransitionLockError && error.code === "MISSION_TRANSITION_LOCK_REPLACED",
  );
  assert.equal(fs.existsSync(held.lock_path), true);
});

test("withMissionTransitionLock releases after success and operation failure", () => {
  const root = tmp();
  assert.equal(withMissionTransitionLock({ stateDir: root, missionId: "mission-ok", timeoutMs: 0 }, () => 42), 42);
  assert.equal(inspectMissionTransitionLock({ stateDir: root, missionId: "mission-ok" }), null);
  assert.throws(
    () => withMissionTransitionLock({ stateDir: root, missionId: "mission-error", timeoutMs: 0 }, () => { throw new Error("boom"); }),
    /boom/,
  );
  assert.equal(inspectMissionTransitionLock({ stateDir: root, missionId: "mission-error" }), null);
});
