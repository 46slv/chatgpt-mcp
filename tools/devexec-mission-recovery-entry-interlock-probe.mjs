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
  const missionId = "MISSION-RECOVERY-INTERLOCK-PROBE";
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
    'fs.writeFileSync(file,JSON.stringify({protocol:"devexec.mission-lock",schema_version:1,token,owner:`dead-interlock:${process.pid}`,pid:process.pid,acquired_at:new Date().toISOString(),publication:"probe"},null,2)+"\\n","utf8");',
    'fs.writeFileSync(tokenFile,JSON.stringify({token,pid:process.pid}),"utf8");',
    'process.exit(77);',
  ].join("")], {encoding: "utf8"});
  assert.equal(crashed.status, 77, crashed.stderr || crashed.stdout);

  const dead = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
  const neutral = `${canonical}.stale-${dead.token}.json`;
  const liveOwner = `${canonical}.stale-${dead.token}.recover-${process.pid}-live-owner.json`;

  // A live movable recovery owner exists. A leftover neutral hard-link exists at
  // the same time. Mission entry must not consume the neutral path and bypass the
  // live owner. Current reviewed semantics do, which is what this diagnostic
  // intentionally detects.
  fs.linkSync(canonical, liveOwner);
  fs.linkSync(canonical, neutral);

  let localAgentCalls = 0;
  let error = null;
  try {
    startMissionLocalAgent({
      base: root,
      identity: {mission_id: missionId, run_id: runId, parent_run_id: null},
      start_attempt_id: "INTERLOCK-PROBE-START",
      start_local_agent: () => {
        localAgentCalls += 1;
        return {run_id: "LOCAL-AGENT-SHOULD-NOT-RUN", decision: "COMPLETE"};
      },
    });
  } catch (caught) {
    error = caught;
  }

  const report = {
    current_error: error?.message ?? null,
    local_agent_calls: localAgentCalls,
    canonical_exists: fs.existsSync(canonical),
    live_owner_exists: fs.existsSync(liveOwner),
    neutral_exists: fs.existsSync(neutral),
    bug_reproduced: localAgentCalls > 0,
    required_after_repair: "live recovery owner blocks Mission entry before Local Agent side effects even when neutral evidence also exists",
  };
  console.log(JSON.stringify(report, null, 2));

  if (report.bug_reproduced) {
    console.log("MISSION_RECOVERY_ENTRY_INTERLOCK_PROBE=REPRODUCED");
  } else {
    console.error("MISSION_RECOVERY_ENTRY_INTERLOCK_PROBE=NOT_REPRODUCED");
    process.exitCode = 2;
  }
} finally {
  fs.rmSync(root, {recursive: true, force: true});
}
