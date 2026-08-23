import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

import {acquireMissionLock, missionLockPath} from "./devexec-mission-lock.mjs";

const self = fileURLToPath(import.meta.url);
const helperMode = process.env.DEVEXEC_MISSION_LOCK_HELPER ?? "";
const sleeper = new Int32Array(new SharedArrayBuffer(4));

function sleep(ms) {
  Atomics.wait(sleeper, 0, 0, ms);
}

function runLockHelper(mode) {
  const root = process.env.DEVEXEC_MISSION_LOCK_ROOT;
  const ready = process.env.DEVEXEC_MISSION_LOCK_READY;
  const release = process.env.DEVEXEC_MISSION_LOCK_RELEASE;
  if (!root || !ready) process.exit(91);

  const lock = acquireMissionLock(root, {owner: `helper:${process.pid}`});
  fs.writeFileSync(ready, `${process.pid}\n`, "utf8");

  if (mode === "crash_with_lock") {
    // Exit without calling release(). The OS closes the descriptor, but the
    // durable lock file intentionally remains and must block blind takeover.
    process.exit(77);
  }

  if (mode !== "hold_until_release" || !release) process.exit(92);
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(release) && Date.now() < deadline) sleep(20);
  if (!fs.existsSync(release)) process.exit(93);
  lock.release();
  process.exit(0);
}

if (helperMode) {
  runLockHelper(helperMode);
} else {
  function withRoot(fn) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-lock-process-"));
    return Promise.resolve(fn(root)).finally(() => fs.rmSync(root, {recursive: true, force: true}));
  }

  async function waitForFile(file, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (!fs.existsSync(file) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(fs.existsSync(file), `timed out waiting for ${file}`);
  }

  function waitForExit(child, timeoutMs = 5000) {
    if (child.exitCode != null || child.signalCode != null) {
      return Promise.resolve({code: child.exitCode, signal: child.signalCode});
    }
    return new Promise((resolve, reject) => {
      let timer = null;
      const finish = (fn, value) => {
        if (timer) clearTimeout(timer);
        fn(value);
      };
      child.once("error", error => finish(reject, error));
      child.once("exit", (code, signal) => finish(resolve, {code, signal}));
      timer = setTimeout(() => {
        child.kill();
        reject(new Error("lock helper did not exit"));
      }, timeoutMs);
    });
  }

  function spawnHelper(root, mode, ready, release = "") {
    return spawn(process.execPath, [self], {
      env: {
        ...process.env,
        DEVEXEC_MISSION_LOCK_HELPER: mode,
        DEVEXEC_MISSION_LOCK_ROOT: root,
        DEVEXEC_MISSION_LOCK_READY: ready,
        DEVEXEC_MISSION_LOCK_RELEASE: release,
      },
      stdio: "ignore",
      windowsHide: true,
    });
  }

  test("real concurrent process cannot acquire a held Mission lock", () => withRoot(async root => {
    const ready = path.join(root, "holder.ready");
    const release = path.join(root, "holder.release");
    const child = spawnHelper(root, "hold_until_release", ready, release);
    try {
      await waitForFile(ready);
      assert.throws(
        () => acquireMissionLock(root, {owner: "competing-process"}),
        /MISSION_CONTROL_LOCKED/,
      );
      const record = JSON.parse(fs.readFileSync(missionLockPath(root), "utf8"));
      assert.match(record.owner, /^helper:\d+$/);
      fs.writeFileSync(release, "release\n", "utf8");
      const exited = await waitForExit(child);
      assert.equal(exited.code, 0);
      assert.equal(exited.signal, null);
      assert.equal(fs.existsSync(missionLockPath(root)), false);

      const after = acquireMissionLock(root, {owner: "post-release"});
      after.release();
    } finally {
      if (child.exitCode == null && child.signalCode == null) child.kill();
    }
  }));

  test("real process exit leaves a stale Mission lock that fails closed", () => withRoot(async root => {
    const ready = path.join(root, "crashed.ready");
    const child = spawnHelper(root, "crash_with_lock", ready);
    await waitForFile(ready);
    const exited = await waitForExit(child);
    assert.equal(exited.code, 77);
    assert.equal(exited.signal, null);
    assert.equal(fs.existsSync(missionLockPath(root)), true);
    assert.throws(
      () => acquireMissionLock(root, {owner: "restart-process"}),
      /MISSION_CONTROL_LOCKED/,
    );
  }));
}
