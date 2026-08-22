import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {openMissionControl} from "./devexec-mission-control.mjs";
import {
  activateMissionChildRun,
  beginMissionChildRunStart,
  markMissionChildRunAmbiguous,
  reserveMissionChildRun,
} from "./devexec-mission-run-admission.mjs";
import {loadMissionState} from "./devexec-mission-state.mjs";

function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-admission-"));
  return Promise.resolve(fn(root)).finally(() => fs.rmSync(root, {recursive: true, force: true}));
}

function childInput(root, overrides = {}) {
  return {
    base: root,
    mission_id: "MISSION-001",
    run_id: overrides.run_id ?? "RUN-002",
    parent_run_id: overrides.parent_run_id ?? "RUN-001",
  };
}

test("reservation validates lineage without making the child current", () => withRoot(root => {
  const parent = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  const reserved = reserveMissionChildRun(childInput(root));
  const disk = loadMissionState(parent.paths.state_file);

  assert.equal(reserved.deduplicated, false);
  assert.equal(reserved.run.status, "RESERVED");
  assert.equal(disk.current_run_id, "RUN-001");
  assert.equal(disk.runs.find(run => run.run_id === "RUN-002").status, "RESERVED");
  assert.throws(
    () => openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-002", parent_run_id: "RUN-001"}),
    /STALE_RUN_ID/,
  );
}));

test("STARTING is a durable pre-side-effect fence and cannot be replayed with another attempt", () => withRoot(root => {
  openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  reserveMissionChildRun(childInput(root));
  const begun = beginMissionChildRunStart({...childInput(root), start_attempt_id: "START-001"});
  const repeated = beginMissionChildRunStart({...childInput(root), start_attempt_id: "START-001"});

  assert.equal(begun.run.status, "STARTING");
  assert.equal(repeated.deduplicated, true);
  assert.throws(
    () => beginMissionChildRunStart({...childInput(root), start_attempt_id: "START-OTHER"}),
    /MISSION_CHILD_START_IN_FLIGHT/,
  );
  assert.throws(() => reserveMissionChildRun(childInput(root)), /MISSION_CHILD_START_IN_FLIGHT/);
}));

test("activation moves current run only after the matching start attempt succeeds", () => withRoot(root => {
  openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  reserveMissionChildRun(childInput(root));
  beginMissionChildRunStart({...childInput(root), start_attempt_id: "START-001"});
  assert.throws(
    () => activateMissionChildRun({...childInput(root), start_attempt_id: "START-WRONG"}),
    /MISSION_CHILD_START_ATTEMPT_MISMATCH/,
  );

  const active = activateMissionChildRun({...childInput(root), start_attempt_id: "START-001"});
  assert.equal(active.run.status, "ACTIVE");
  assert.equal(active.state.current_run_id, "RUN-002");
  const child = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-002", parent_run_id: "RUN-001"});
  assert.equal(child.state.current_run_id, "RUN-002");
}));

test("ambiguous child start remains non-current and permanently blocks automatic replay", () => withRoot(root => {
  const parent = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  reserveMissionChildRun(childInput(root));
  beginMissionChildRunStart({...childInput(root), start_attempt_id: "START-001"});
  const ambiguous = markMissionChildRunAmbiguous({
    ...childInput(root),
    start_attempt_id: "START-001",
    reason: "LOCAL_AGENT_START_RESULT_UNREADABLE",
  });

  assert.equal(ambiguous.run.status, "AMBIGUOUS");
  assert.equal(ambiguous.state.current_run_id, "RUN-001");
  assert.equal(loadMissionState(parent.paths.state_file).current_run_id, "RUN-001");
  assert.throws(() => reserveMissionChildRun(childInput(root)), /MISSION_CHILD_START_AMBIGUOUS/);
  assert.throws(
    () => beginMissionChildRunStart({...childInput(root), start_attempt_id: "START-002"}),
    /MISSION_CHILD_START_AMBIGUOUS/,
  );
}));

test("reservation is idempotent before STARTING but rejects conflicting lineage", () => withRoot(root => {
  openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  const first = reserveMissionChildRun(childInput(root));
  const repeated = reserveMissionChildRun(childInput(root));
  assert.equal(first.deduplicated, false);
  assert.equal(repeated.deduplicated, true);
  assert.throws(
    () => reserveMissionChildRun(childInput(root, {parent_run_id: "RUN-OTHER"})),
    /STALE_PARENT_RUN_ID|RUN_LINEAGE_CONFLICT/,
  );
}));
