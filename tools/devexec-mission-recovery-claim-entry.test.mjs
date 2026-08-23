import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {startMissionLocalAgent} from "./devexec-mission-entry-runtime.mjs";
import {missionLockPath} from "./devexec-mission-lock.mjs";
import {resolveMissionPaths} from "./devexec-mission-state.mjs";

function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-recovery-claim-entry-"));
  return Promise.resolve(fn(root)).finally(() => fs.rmSync(root, {recursive: true, force: true}));
}

function createDeadMissionLock(root, missionId) {
  const paths = resolveMissionPaths(root, missionId);
  const canonical = missionLockPath(paths.root);
  const tokenFile = path.join(root, `dead-token-${missionId}.txt`);

  const crashed = spawnSync(process.execPath, ["-e", [
    'const fs=require("node:fs");',
    'const path=require("node:path");',
    'const crypto=require("node:crypto");',
    `const file=${JSON.stringify(canonical)};`,
    `const tokenFile=${JSON.stringify(tokenFile)};`,
    'const token=crypto.randomUUID();',
    'fs.mkdirSync(path.dirname(file),{recursive:true});',
    'fs.writeFileSync(file,JSON.stringify({protocol:"devexec.mission-lock",schema_version:1,token,owner:`dead-entry:${process.pid}`,pid:process.pid,acquired_at:new Date().toISOString(),publication:"hardlink-v1"},null,2)+"\\n","utf8");',
    'fs.writeFileSync(tokenFile,JSON.stringify({token,pid:process.pid}),"utf8");',
    'process.exit(77);',
  ].join("")], {encoding: "utf8"});
  assert.equal(crashed.status, 77, crashed.stderr || crashed.stdout);

  const dead = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
  return {canonical, ...dead};
}

test("interrupted neutral stale-recovery claim resumes before exactly one Local Agent start", () => withRoot(root => {
  const missionId = "MISSION-RECOVERY-CLAIM";
  const runId = "RUN-ROOT";
  const dead = createDeadMissionLock(root, missionId);
  const quarantine = `${dead.canonical}.stale-${dead.token}.json`;

  fs.linkSync(dead.canonical, quarantine);

  let calls = 0;
  const result = startMissionLocalAgent({
    base: root,
    identity: {mission_id: missionId, run_id: runId, parent_run_id: null},
    start_attempt_id: "START-RESUMED-RECOVERY",
    start_local_agent: () => {
      calls += 1;
      return {run_id: "LOCAL-AGENT-ONCE", decision: "COMPLETE"};
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.agent.run_id, "LOCAL-AGENT-ONCE");
  assert.equal(result.lock_recovery.recovered, true);
  assert.equal(result.lock_recovery.status, "STALE_RECOVERED");
  assert.equal(result.lock_recovery.recovery_claim_mode, "movable-owner-v2");
  assert.equal(fs.existsSync(dead.canonical), false);
  assert.equal(fs.existsSync(result.lock_recovery.quarantine_file), true);
  const evidence = JSON.parse(fs.readFileSync(result.lock_recovery.quarantine_file, "utf8"));
  assert.equal(evidence.token, dead.token);
  assert.equal(evidence.pid, dead.pid);
}));

test("a live recovery owner still blocks Mission entry before Local Agent side effects", () => withRoot(root => {
  const missionId = "MISSION-LIVE-RECOVERY-OWNER";
  const runId = "RUN-ROOT";
  const dead = createDeadMissionLock(root, missionId);
  const neutral = `${dead.canonical}.stale-${dead.token}.json`;
  const liveOwner = `${dead.canonical}.stale-${dead.token}.recover-${process.pid}-live-owner.json`;
  fs.linkSync(dead.canonical, neutral);
  fs.renameSync(neutral, liveOwner);

  let calls = 0;
  assert.throws(
    () => startMissionLocalAgent({
      base: root,
      identity: {mission_id: missionId, run_id: runId, parent_run_id: null},
      start_attempt_id: "START-MUST-BLOCK",
      start_local_agent: () => {
        calls += 1;
        return {run_id: "MUST-NOT-RUN", decision: "COMPLETE"};
      },
    }),
    /MISSION_CONTROL_LOCK_RECOVERY_ALREADY_CLAIMED/,
  );

  assert.equal(calls, 0);
  assert.equal(fs.existsSync(dead.canonical), true);
  assert.equal(fs.existsSync(liveOwner), true);
}));
