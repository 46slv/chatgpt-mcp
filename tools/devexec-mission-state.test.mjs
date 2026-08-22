import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  attachMissionRun,
  createMissionState,
  loadMissionState,
  resolveMissionPaths,
  saveMissionState,
} from "./devexec-mission-state.mjs";

test("mission paths stay under one sanitized mission root", () => {
  const base = path.join(os.tmpdir(), "mission-base");
  const paths = resolveMissionPaths(base, "MISSION-001");
  assert.equal(paths.root, path.join(path.resolve(base), "ChatGPTMCPProbe", "dev-exec-missions", "MISSION-001"));
  assert.equal(paths.state_file, path.join(paths.root, "mission-state.json"));
  assert.equal(paths.amendments_file, path.join(paths.root, "amendments.json"));
  assert.equal(paths.launch_journal_file, path.join(paths.root, "launch-events.jsonl"));
  assert.throws(() => resolveMissionPaths(base, "../escape"), /invalid mission_id/);
  assert.throws(() => resolveMissionPaths(base, "bad/path"), /invalid mission_id/);
});

test("root run creates stable mission lineage", () => {
  const state = createMissionState({
    mission_id: "MISSION-001",
    root_run_id: "RUN-001",
    now: "2026-08-23T04:45:00+09:00",
  });
  assert.equal(state.mission_id, "MISSION-001");
  assert.equal(state.current_run_id, "RUN-001");
  assert.equal(state.revision, 0);
  assert.deepEqual(state.runs, [{run_id: "RUN-001", parent_run_id: null, attached_at: "2026-08-23T04:45:00+09:00"}]);
});

test("child run attachment is durable, deduplicated, and lineage-checked", () => {
  const state = createMissionState({mission_id: "MISSION-001", root_run_id: "RUN-001"});
  const first = attachMissionRun(state, {run_id: "RUN-002", parent_run_id: "RUN-001", now: "2026-08-23T04:46:00+09:00"});
  const second = attachMissionRun(state, {run_id: "RUN-002", parent_run_id: "RUN-001"});
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(state.current_run_id, "RUN-002");
  assert.equal(state.revision, 1);
  assert.equal(state.runs.length, 2);
  assert.throws(() => attachMissionRun(state, {run_id: "RUN-002", parent_run_id: "RUN-OTHER"}), /RUN_LINEAGE_CONFLICT/);
  assert.throws(() => attachMissionRun(state, {run_id: "RUN-003", parent_run_id: "RUN-UNKNOWN"}), /unknown parent_run_id/);
});

test("mission state survives atomic save/load with lineage intact", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mission-state-"));
  const file = path.join(root, "state", "mission-state.json");
  try {
    const state = createMissionState({mission_id: "MISSION-001", root_run_id: "RUN-001"});
    attachMissionRun(state, {run_id: "RUN-002", parent_run_id: "RUN-001"});
    saveMissionState(file, state);
    const loaded = loadMissionState(file);
    assert.equal(loaded.mission_id, "MISSION-001");
    assert.equal(loaded.current_run_id, "RUN-002");
    assert.deepEqual(loaded.runs.map(run => [run.run_id, run.parent_run_id]), [["RUN-001", null], ["RUN-002", "RUN-001"]]);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});
