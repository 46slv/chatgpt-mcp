import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {startMissionLocalAgent} from "./devexec-mission-entry-runtime.mjs";
import {loadMissionState, resolveMissionPaths} from "./devexec-mission-state.mjs";

function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-root-start-review-"));
  return Promise.resolve(fn(root)).finally(() => fs.rmSync(root, {recursive: true, force: true}));
}

const identity = {mission_id: "MISSION-ROOT", run_id: "RUN-ROOT", parent_run_id: null};

test("root entry is durably STARTING before Local Agent side effect and ACTIVE after success", () => withRoot(root => {
  let duringStart = null;
  const result = startMissionLocalAgent({
    base: root,
    identity,
    start_attempt_id: "ROOT-START-001",
    start_local_agent: () => {
      duringStart = loadMissionState(resolveMissionPaths(root, identity.mission_id).state_file);
      return {run_id: "AGENT-ROOT", decision: "COMPLETE"};
    },
  });

  const duringRun = duringStart.runs.find(run => run.run_id === identity.run_id);
  assert.equal(duringStart.current_run_id, identity.run_id);
  assert.equal(duringRun.status, "STARTING");
  assert.equal(duringRun.start_attempt_id, "ROOT-START-001");

  const disk = loadMissionState(resolveMissionPaths(root, identity.mission_id).state_file);
  const activeRun = disk.runs.find(run => run.run_id === identity.run_id);
  assert.equal(activeRun.status, "ACTIVE");
  assert.equal(result.agent.run_id, "AGENT-ROOT");
  assert.equal(result.start_attempt_id, "ROOT-START-001");
}));

test("ambiguous root Local Agent start is never automatically replayed", () => withRoot(root => {
  let calls = 0;
  assert.throws(
    () => startMissionLocalAgent({
      base: root,
      identity,
      start_attempt_id: "ROOT-START-001",
      start_local_agent: () => {
        calls += 1;
        throw new Error("unreadable root start result");
      },
    }),
    /unreadable root start result/,
  );

  const first = loadMissionState(resolveMissionPaths(root, identity.mission_id).state_file);
  const ambiguousRun = first.runs.find(run => run.run_id === identity.run_id);
  assert.equal(ambiguousRun.status, "AMBIGUOUS");
  assert.match(ambiguousRun.ambiguous_reason, /unreadable root start result/);

  assert.throws(
    () => startMissionLocalAgent({
      base: root,
      identity,
      start_attempt_id: "ROOT-START-002",
      start_local_agent: () => {
        calls += 1;
        return {run_id: "MUST-NOT-RUN", decision: "COMPLETE"};
      },
    }),
    /MISSION_ROOT_START_AMBIGUOUS/,
  );
  assert.equal(calls, 1);
}));
