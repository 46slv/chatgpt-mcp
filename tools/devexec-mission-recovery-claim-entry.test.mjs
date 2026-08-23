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

test("interrupted stale-recovery claim blocks Mission entry before Local Agent side effects", () => withRoot(root => {
  const missionId = "MISSION-RECOVERY-CLAIM";
  const runId = "RUN-ROOT";
  const paths = resolveMissionPaths(root, missionId);
  const canonical = missionLockPath(paths.root);
  const tokenFile = path.join(root, "dead-token.txt");

  const crashed = spawnSync(process.execPath, ["-e", [
    'const fs=require("node:fs");',
    'const path=require("node:path");',
    'const crypto=require("node:crypto");',
    `const file=${JSON.stringify(canonical)};`,
    `const tokenFile=${JSON.stringify(tokenFile)};`,
    'const token=crypto.randomUUID();',
    'fs.mkdirSync(path.dirname(file),{recursive:true});',
    'fs.writeFileSync(file,JSON.stringify({protocol:"devexec.mission-lock",schema_version:1,token,owner:`dead-entry:${process.pid}`,pid:process.pid,acquired_at:new Date().toISOString(),publication:"hardlink-v1"},null,2)+"\\n","utf8");',
    'fs.writeFileSync(tokenFile,token,"utf8");',
    'process.exit(77);',
  ].join("")], {encoding: "utf8"});
  assert.equal(crashed.status, 77, crashed.stderr || crashed.stdout);

  const token = fs.readFileSync(tokenFile, "utf8").trim();
  const quarantine = `${canonical}.stale-${token}.json`;
  fs.linkSync(canonical, quarantine);

  let calls = 0;
  assert.throws(
    () => startMissionLocalAgent({
      base: root,
      identity: {mission_id: missionId, run_id: runId, parent_run_id: null},
      start_attempt_id: "START-INTERRUPTED-RECOVERY",
      start_local_agent: () => {
        calls += 1;
        return {run_id: "MUST-NOT-RUN", decision: "COMPLETE"};
      },
    }),
    /MISSION_CONTROL_LOCK_RECOVERY_ALREADY_CLAIMED/,
  );

  assert.equal(calls, 0);
  assert.equal(fs.existsSync(canonical), true);
  assert.equal(fs.existsSync(quarantine), true);
  const canonicalRecord = JSON.parse(fs.readFileSync(canonical, "utf8"));
  const quarantineRecord = JSON.parse(fs.readFileSync(quarantine, "utf8"));
  assert.equal(canonicalRecord.token, token);
  assert.equal(quarantineRecord.token, token);
}));
