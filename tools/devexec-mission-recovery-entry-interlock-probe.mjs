import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {startMissionLocalAgent} from "./devexec-mission-entry-runtime.mjs";
import {missionLockPath} from "./devexec-mission-lock.mjs";
import {resolveMissionPaths} from "./devexec-mission-state.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-recovery-entry-interlock-"));
try {
  const missionId = "MISSION-RECOVERY-INTERLOCK-REGRESSION";
  const runId = "RUN-ROOT";
  const paths = resolveMissionPaths(root, missionId);
  const canonical = missionLockPath(paths.root);
  const tokenFile = path.join(root, "dead-lock.json");

  const crashed = spawnSync(process.execPath, ["-e", [
    'const fs=require("node:fs");',
    'const path=require("node:path");',
    'const crypto=require("node:crypto");',
    `const file=${JSON.stringify(canonical)};`,
    `const tokenFile=${JSON.stringify(tokenFile)};`,
    'const token=crypto.randomUUID();',
    'fs.mkdirSync(path.dirname(file),{recursive:true});',
    'fs.writeFileSync(file,JSON.stringify({protocol:"devexec.mission-lock",schema_version:1,token,owner:`dead-interlock:${process.pid}`,pid:process.pid,acquired_at:new Date().toISOString(),publication:"regression"},null,2)+"\\n","utf8");',
    'fs.writeFileSync(tokenFile,JSON.stringify({token,pid:process.pid}),"utf8");',
    'process.exit(77);',
  ].join("")], {encoding: "utf8"});
  assert.equal(crashed.status, 77, crashed.stderr || crashed.stdout);

  const dead = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
  const neutral = `${canonical}.stale-${dead.token}.json`;
  const liveOwner = `${canonical}.stale-${dead.token}.recover-${process.pid}-live-owner.json`;
  fs.linkSync(canonical, liveOwner);
  fs.linkSync(canonical, neutral);

  let localAgentCalls = 0;
  let error = null;
  try {
    startMissionLocalAgent({
      base: root,
      identity: {mission_id: missionId, run_id: runId, parent_run_id: null},
      start_attempt_id: "INTERLOCK-REGRESSION-START",
      start_local_agent: () => {
        localAgentCalls += 1;
        return {run_id: "LOCAL-AGENT-SHOULD-NOT-RUN", decision: "COMPLETE"};
      },
    });
  } catch (caught) {
    error = caught;
  }

  assert.equal(error?.message, "MISSION_CONTROL_LOCK_RECOVERY_MIXED_CLAIMS");
  assert.equal(localAgentCalls, 0);
  assert.equal(fs.existsSync(canonical), true);
  assert.equal(fs.existsSync(liveOwner), true);
  assert.equal(fs.existsSync(neutral), true);

  console.log(JSON.stringify({
    error: error.message,
    local_agent_calls: localAgentCalls,
    canonical_intact: true,
    live_owner_intact: true,
    neutral_intact: true,
  }, null, 2));
  console.log("MISSION_RECOVERY_ENTRY_INTERLOCK_REGRESSION=PASS");
} finally {
  fs.rmSync(root, {recursive: true, force: true});
}
