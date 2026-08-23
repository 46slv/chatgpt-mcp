import assert from "node:assert/strict";
import {spawn, spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {acquireMissionLock, missionLockPath, withMissionLock} from "./devexec-mission-lock.mjs";
import {recoverOrResumeStaleMissionLock} from "./devexec-mission-lock-resume.mjs";

const self = fileURLToPath(import.meta.url);
const requestedProbeParent = process.env.DEVEXEC_MISSION_HOST_PROBE_ROOT?.trim();
const probeParent = requestedProbeParent ? path.resolve(requestedProbeParent) : os.tmpdir();
if (!fs.existsSync(probeParent)) {
  throw new Error(`DEVEXEC_MISSION_HOST_PROBE_ROOT does not exist: ${probeParent}`);
}

function writeJsonLine(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function readJsonLine(text) {
  const line = String(text ?? "").trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) throw new Error("child produced no JSON result");
  return JSON.parse(line);
}

function waitForImmediate() {
  return new Promise(resolve => setImmediate(resolve));
}

async function waitForFile(file, child, timeoutMs = 5000) {
  const started = Date.now();
  let childExit = null;
  child.once("exit", (code, signal) => { childExit = {code, signal}; });
  while (!fs.existsSync(file)) {
    if (childExit) {
      throw new Error(`holder exited before ready: ${JSON.stringify(childExit)}`);
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for holder readiness: ${file}`);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for child exit")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function runTryLockChild(root) {
  const result = spawnSync(process.execPath, [self, "--child-try-lock", root], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`try-lock child failed: status=${result.status} stderr=${String(result.stderr ?? "").trim()}`);
  }
  return readJsonLine(result.stdout);
}

async function runLiveOwnerKillRecovery() {
  const root = fs.mkdtempSync(path.join(probeParent, ".devexec-mission-host-live-kill-"));
  const readyFile = path.join(root, "holder-ready.json");
  const holder = spawn(process.execPath, [self, "--child-hold-lock", root, readyFile], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  holder.stderr.setEncoding("utf8");
  holder.stderr.on("data", chunk => { stderr += chunk; });

  try {
    await waitForFile(readyFile, holder);
    const ready = JSON.parse(fs.readFileSync(readyFile, "utf8"));
    assert.equal(Number.isSafeInteger(ready.pid), true);
    assert.equal(ready.pid, holder.pid);
    assert.equal(fs.existsSync(missionLockPath(root)), true);

    assert.throws(
      () => recoverOrResumeStaleMissionLock(root),
      error => {
        assert.equal(error?.message, "MISSION_CONTROL_LOCK_OWNER_ALIVE");
        assert.equal(error?.owner_pid, holder.pid);
        return true;
      },
    );

    const killed = holder.kill("SIGKILL");
    assert.equal(killed, true, "holder process must accept forced termination request");
    await waitForExit(holder);
    assert.equal(fs.existsSync(missionLockPath(root)), true, "forced process death must leave durable canonical evidence");

    const recovered = recoverOrResumeStaleMissionLock(root);
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.status, "STALE_RECOVERED");
    assert.equal(fs.existsSync(missionLockPath(root)), false);

    const after = acquireMissionLock(root, {owner: "host-acceptance-after-recovery"});
    assert.equal(after.release(), true);
    return {
      test: "live-owner-refusal-and-forced-kill-recovery",
      status: "PASS",
      holder_pid: ready.pid,
      recovery_mode: recovered.recovery_claim_mode,
    };
  } catch (error) {
    if (stderr.trim()) error.holder_stderr = stderr.trim();
    throw error;
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) {
      try { holder.kill("SIGKILL"); } catch {}
      try { await waitForExit(holder, 1000); } catch {}
    }
    fs.rmSync(root, {recursive: true, force: true});
  }
}

async function runThenableLifetimeCrossProcess() {
  const root = fs.mkdtempSync(path.join(probeParent, ".devexec-mission-host-thenable-"));
  let releaseGate;
  let continuationSawCanonical = null;
  const gate = new Promise(resolve => { releaseGate = resolve; });

  try {
    assert.throws(
      () => withMissionLock(root, () => gate.then(() => {
        continuationSawCanonical = fs.existsSync(missionLockPath(root));
      })),
      error => {
        assert.equal(error?.message, "MISSION_LOCK_ASYNC_CALLBACK_UNSUPPORTED");
        assert.equal(error?.lock_release_deferred, true);
        return true;
      },
    );

    assert.equal(fs.existsSync(missionLockPath(root)), true, "canonical lock must remain published while returned thenable is pending");
    const whilePending = runTryLockChild(root);
    assert.equal(whilePending.acquired, false);
    assert.equal(whilePending.error, "MISSION_CONTROL_LOCKED");

    releaseGate();
    await waitForImmediate();
    await waitForImmediate();
    assert.equal(continuationSawCanonical, true, "returned continuation must execute before deferred lock release");
    assert.equal(fs.existsSync(missionLockPath(root)), false, "canonical lock must release after returned thenable settles");

    const afterSettlement = runTryLockChild(root);
    assert.equal(afterSettlement.acquired, true);
    return {
      test: "returned-thenable-cross-process-exclusion",
      status: "PASS",
      pending_child_error: whilePending.error,
      after_settlement_acquired: afterSettlement.acquired,
    };
  } finally {
    releaseGate?.();
    await waitForImmediate();
    fs.rmSync(root, {recursive: true, force: true});
  }
}

async function childHoldLock(root, readyFile) {
  const lock = acquireMissionLock(root, {owner: "host-acceptance-holder"});
  fs.writeFileSync(readyFile, JSON.stringify({pid: process.pid, token: lock.token}) + "\n", "utf8");
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

function childTryLock(root) {
  try {
    const lock = acquireMissionLock(root, {owner: "host-acceptance-competitor"});
    lock.release();
    writeJsonLine({acquired: true, error: null});
    return 0;
  } catch (error) {
    if (error?.message === "MISSION_CONTROL_LOCKED") {
      writeJsonLine({acquired: false, error: error.message});
      return 0;
    }
    process.stderr.write(`${error?.stack || error}\n`);
    return 2;
  }
}

const mode = process.argv[2] ?? null;
if (mode === "--child-hold-lock") {
  await childHoldLock(process.argv[3], process.argv[4]);
} else if (mode === "--child-try-lock") {
  process.exitCode = childTryLock(process.argv[3]);
} else {
  const results = [];
  results.push(await runLiveOwnerKillRecovery());
  results.push(await runThenableLifetimeCrossProcess());
  const report = {
    protocol: "devexec.mission-host-lock-acceptance",
    schema_version: 1,
    generated_at: new Date().toISOString(),
    host: os.hostname(),
    platform: process.platform,
    node: process.version,
    probe_parent: probeParent,
    results,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write("MISSION_HOST_LOCK_ACCEPTANCE=PASS\n");
}
