import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {applyMissionLoopBoundary} from "./devexec-mission-loop-boundary.mjs";
import {enqueueMissionAmendment, openMissionControl} from "./devexec-mission-control.mjs";
import {
  beginMissionChildLaunch,
  completeMissionChildLaunch,
  readMissionLaunchState,
  reconcileMissionChildLaunches,
} from "./devexec-mission-launch.mjs";

function tempBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-loop-boundary-"));
}

function attachConfirmedChild({base, missionId, parentRunId, continuation}) {
  const parent = openMissionControl({base, mission_id: missionId, run_id: parentRunId});
  const attemptId = `${continuation.launch_id}:test-attempt`;
  beginMissionChildLaunch(parent, continuation.launch_id, {
    launch_attempt_id: attemptId,
    launcher_request_id: `${continuation.launch_id}:test-request`,
    lease_token: `${continuation.launch_id}:test-lease`,
  });
  completeMissionChildLaunch(parent, continuation.launch_id, {
    launch_attempt_id: attemptId,
    receipt: {test: true, launch_id: continuation.launch_id},
  });
  const child = openMissionControl({
    base,
    mission_id: missionId,
    run_id: continuation.child_run_id,
    parent_run_id: parentRunId,
  });
  const reconciled = reconcileMissionChildLaunches(child);
  assert.equal(reconciled.changed, true);
  const launch = readMissionLaunchState(child).launches.find(item => item.launch_id === continuation.launch_id);
  assert.equal(launch.status, "CONFIRMED");
  return child;
}

test("constraint remains pending until a runtime enforcement surface exists", () => {
  const base = tempBase();
  const control = openMissionControl({base, mission_id: "MISSION-A", run_id: "RUN-A"});
  enqueueMissionAmendment(control, {
    amendment_id: "AMEND-CONSTRAINT",
    idempotency_key: "constraint-1",
    kind: "MISSION_AMENDMENT",
    apply_mode: "next_safe_boundary",
    payload: {constraint: "preserve existing host boundary"},
  });

  const result = applyMissionLoopBoundary({
    base,
    mission_id: "MISSION-A",
    run_id: "RUN-A",
    current_goal_complete: false,
  });

  assert.equal(result.applied.length, 0);
  assert.deepEqual(result.skipped, [{amendment_id: "AMEND-CONSTRAINT", reason: "UNSUPPORTED_MUTATION_TARGET"}]);
  assert.equal(result.objective.constraints.length, 0);
  assert.equal(result.objective.queued_work.length, 0);
  assert.equal(result.continuation, null);
  const reopened = openMissionControl({base, mission_id: "MISSION-A", run_id: "RUN-A"});
  assert.equal(reopened.amendments.amendments[0].status, "PENDING");
});

test("after_current_goal creates one deterministic durable child launch intent", () => {
  const base = tempBase();
  const control = openMissionControl({base, mission_id: "MISSION-B", run_id: "RUN-ROOT"});
  enqueueMissionAmendment(control, {
    amendment_id: "AMEND-WORK",
    idempotency_key: "work-1",
    kind: "MISSION_AMENDMENT",
    apply_mode: "after_current_goal",
    payload: {add_work: "run the adjacent verification unit"},
  });

  const before = applyMissionLoopBoundary({
    base,
    mission_id: "MISSION-B",
    run_id: "RUN-ROOT",
    current_goal_complete: false,
  });
  assert.equal(before.applied.length, 0);
  assert.equal(before.continuation, null);

  const first = applyMissionLoopBoundary({
    base,
    mission_id: "MISSION-B",
    run_id: "RUN-ROOT",
    current_goal_complete: true,
  });
  assert.equal(first.applied.length, 1);
  assert.equal(first.objective.queued_work.length, 1);
  assert.equal(first.continuation.status, "PENDING");
  assert.equal(first.continuation.deduplicated, false);

  const second = applyMissionLoopBoundary({
    base,
    mission_id: "MISSION-B",
    run_id: "RUN-ROOT",
    current_goal_complete: true,
  });
  assert.equal(second.continuation.child_run_id, first.continuation.child_run_id);
  assert.equal(second.continuation.launch_id, first.continuation.launch_id);
  assert.equal(second.continuation.deduplicated, true);

  const launchState = readMissionLaunchState(openMissionControl({
    base,
    mission_id: "MISSION-B",
    run_id: "RUN-ROOT",
  }));
  assert.equal(launchState.launches.length, 1);
});

test("root queued work is not re-consumed after the launched child becomes current", () => {
  const base = tempBase();
  const root = openMissionControl({base, mission_id: "MISSION-C", run_id: "RUN-ROOT"});
  enqueueMissionAmendment(root, {
    amendment_id: "AMEND-WORK",
    idempotency_key: "work-1",
    kind: "MISSION_AMENDMENT",
    apply_mode: "after_current_goal",
    payload: {add_work: "one child only"},
  });
  const rootResult = applyMissionLoopBoundary({
    base,
    mission_id: "MISSION-C",
    run_id: "RUN-ROOT",
    current_goal_complete: true,
  });

  attachConfirmedChild({
    base,
    missionId: "MISSION-C",
    parentRunId: "RUN-ROOT",
    continuation: rootResult.continuation,
  });
  const childResult = applyMissionLoopBoundary({
    base,
    mission_id: "MISSION-C",
    run_id: rootResult.continuation.child_run_id,
    parent_run_id: "RUN-ROOT",
    current_goal_complete: true,
  });
  assert.equal(childResult.continuation, null);
});

test("multiple queued work items chain sequentially across confirmed child runs", () => {
  const base = tempBase();
  const root = openMissionControl({base, mission_id: "MISSION-CHAIN", run_id: "RUN-ROOT"});
  enqueueMissionAmendment(root, {
    amendment_id: "AMEND-WORK-1",
    idempotency_key: "chain-1",
    kind: "MISSION_AMENDMENT",
    apply_mode: "after_current_goal",
    payload: {add_work: "first continuation"},
  }, {now: "2026-08-23T00:00:01.000Z"});
  enqueueMissionAmendment(root, {
    amendment_id: "AMEND-WORK-2",
    idempotency_key: "chain-2",
    kind: "MISSION_AMENDMENT",
    apply_mode: "after_current_goal",
    payload: {add_work: "second continuation"},
  }, {now: "2026-08-23T00:00:02.000Z"});

  const first = applyMissionLoopBoundary({
    base,
    mission_id: "MISSION-CHAIN",
    run_id: "RUN-ROOT",
    current_goal_complete: true,
  });
  assert.equal(first.objective.queued_work.length, 2);
  assert.equal(first.continuation.goal, "first continuation");

  attachConfirmedChild({
    base,
    missionId: "MISSION-CHAIN",
    parentRunId: "RUN-ROOT",
    continuation: first.continuation,
  });
  const second = applyMissionLoopBoundary({
    base,
    mission_id: "MISSION-CHAIN",
    run_id: first.continuation.child_run_id,
    parent_run_id: "RUN-ROOT",
    current_goal_complete: true,
  });
  assert.equal(second.continuation.goal, "second continuation");
  assert.notEqual(second.continuation.child_run_id, first.continuation.child_run_id);
});

test("unsupported GOAL_PATCH stays pending and is reported as skipped", () => {
  const base = tempBase();
  const control = openMissionControl({base, mission_id: "MISSION-D", run_id: "RUN-D"});
  enqueueMissionAmendment(control, {
    amendment_id: "PATCH-1",
    idempotency_key: "patch-1",
    kind: "GOAL_PATCH",
    apply_mode: "supersede_current_goal",
    payload: {goal: "replace live goal"},
  });

  const result = applyMissionLoopBoundary({
    base,
    mission_id: "MISSION-D",
    run_id: "RUN-D",
    current_goal_complete: true,
  });
  assert.deepEqual(result.skipped, [{amendment_id: "PATCH-1", reason: "UNSUPPORTED_MUTATION_TARGET"}]);
  const reopened = openMissionControl({base, mission_id: "MISSION-D", run_id: "RUN-D"});
  assert.equal(reopened.amendments.amendments[0].status, "PENDING");
});
