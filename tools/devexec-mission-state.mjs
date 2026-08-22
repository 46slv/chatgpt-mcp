import fs from "node:fs";
import path from "node:path";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertMissionId(value) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error("invalid mission_id");
  return value;
}

function assertRunId(value, name = "run_id") {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`invalid ${name}`);
  return value;
}

export function resolveMissionPaths(base, missionId) {
  if (typeof base !== "string" || !base.trim()) throw new Error("base required");
  const id = assertMissionId(missionId);
  const root = path.join(path.resolve(base), "ChatGPTMCPProbe", "dev-exec-missions", id);
  return {
    root,
    state_file: path.join(root, "mission-state.json"),
    amendments_file: path.join(root, "amendments.json"),
    launch_journal_file: path.join(root, "launch-events.jsonl"),
  };
}

export function createMissionState({mission_id, root_run_id, now = new Date().toISOString()} = {}) {
  const missionId = assertMissionId(mission_id);
  const rootRunId = assertRunId(root_run_id, "root_run_id");
  return {
    protocol: "devexec.mission-state",
    schema_version: 1,
    mission_id: missionId,
    root_run_id: rootRunId,
    current_run_id: rootRunId,
    revision: 0,
    runs: [{run_id: rootRunId, parent_run_id: null, attached_at: now}],
    created_at: now,
    updated_at: now,
  };
}

export function attachMissionRun(state, {run_id, parent_run_id, now = new Date().toISOString()} = {}) {
  if (!state || state.protocol !== "devexec.mission-state" || state.schema_version !== 1) {
    throw new Error("invalid mission state");
  }
  const runId = assertRunId(run_id);
  const parentRunId = assertRunId(parent_run_id, "parent_run_id");
  const existing = state.runs.find(run => run.run_id === runId);
  if (existing) {
    if (existing.parent_run_id !== parentRunId) throw new Error("RUN_LINEAGE_CONFLICT");
    return {state, run: existing, deduplicated: true};
  }
  if (!state.runs.some(run => run.run_id === parentRunId)) throw new Error("unknown parent_run_id");
  const run = {run_id: runId, parent_run_id: parentRunId, attached_at: now};
  state.runs.push(run);
  state.current_run_id = runId;
  state.revision += 1;
  state.updated_at = now;
  return {state, run, deduplicated: false};
}

export function saveMissionState(file, state) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, {recursive: true});
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", "utf8");
  fs.renameSync(temp, file);
}

export function loadMissionState(file) {
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!state || state.protocol !== "devexec.mission-state" || state.schema_version !== 1) {
    throw new Error("invalid mission state file");
  }
  assertMissionId(state.mission_id);
  assertRunId(state.root_run_id, "root_run_id");
  assertRunId(state.current_run_id, "current_run_id");
  if (!Array.isArray(state.runs) || state.runs.length < 1) throw new Error("invalid mission run lineage");
  for (const run of state.runs) {
    assertRunId(run.run_id);
    if (run.parent_run_id !== null) assertRunId(run.parent_run_id, "parent_run_id");
  }
  return state;
}
