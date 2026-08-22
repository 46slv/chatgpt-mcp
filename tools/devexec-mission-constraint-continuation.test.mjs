import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {parseMissionConstraintsEnv, renderMissionGoalWithConstraints} from "./devexec-mission-constraint-envelope.mjs";
import {applyMissionLoopBoundary} from "./devexec-mission-loop-boundary.mjs";
import {enqueueMissionAmendment, openMissionControl} from "./devexec-mission-control.mjs";
import {buildMissionChildLaunchSpec, readMissionLaunchState, requestMissionChildLaunch} from "./devexec-mission-launch.mjs";

function tempBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-constraint-continuation-"));
}

test("after_current_goal constraints are atomically scoped to their queued child work", () => {
  const base = tempBase();
  const control = openMissionControl({base, mission_id: "MISSION-C", run_id: "RUN-ROOT"});
  enqueueMissionAmendment(control, {
    amendment_id: "AMEND-C",
    idempotency_key: "constraint-continuation-1",
    kind: "MISSION_AMENDMENT",
    apply_mode: "after_current_goal",
    payload: {
      add_work: "run adjacent verification",
      constraints: ["do not publish", "preserve target routing"],
    },
  });

  const result = applyMissionLoopBoundary({
    base,
    mission_id: "MISSION-C",
    run_id: "RUN-ROOT",
    current_goal_complete: true,
    target_alias: "chatgpt-mcp",
  });
  assert.equal(result.applied.length, 1);
  assert.deepEqual(result.objective.queued_work[0].constraints, ["do not publish", "preserve target routing"]);
  assert.deepEqual(result.objective.constraints.map(item => item.text), ["do not publish", "preserve target routing"]);
  assert.deepEqual(result.continuation.constraints, ["do not publish", "preserve target routing"]);

  const current = openMissionControl({base, mission_id: "MISSION-C", run_id: "RUN-ROOT"});
  const launch = readMissionLaunchState(current).launches[0];
  assert.deepEqual(launch.constraints, ["do not publish", "preserve target routing"]);
  const spec = buildMissionChildLaunchSpec(current, launch, {node_path: "node", entry_path: "devexec-goal.mjs"});
  assert.equal(spec.env.DEV_EXEC_TARGET_ALIAS, "chatgpt-mcp");
  assert.deepEqual(JSON.parse(spec.env.DEV_EXEC_MISSION_CONSTRAINTS_JSON), ["do not publish", "preserve target routing"]);
});

test("a later work item does not inherit constraints from an unrelated earlier amendment", () => {
  const base = tempBase();
  const control = openMissionControl({base, mission_id: "MISSION-SCOPE", run_id: "RUN-ROOT"});
  enqueueMissionAmendment(control, {
    amendment_id: "AMEND-SCOPED",
    idempotency_key: "scope-1",
    kind: "MISSION_AMENDMENT",
    apply_mode: "after_current_goal",
    payload: {add_work: "first work", constraint: "first-only constraint"},
  }, {now: "2026-08-23T00:00:01.000Z"});
  enqueueMissionAmendment(control, {
    amendment_id: "AMEND-PLAIN",
    idempotency_key: "scope-2",
    kind: "MISSION_AMENDMENT",
    apply_mode: "after_current_goal",
    payload: {add_work: "second work"},
  }, {now: "2026-08-23T00:00:02.000Z"});

  const result = applyMissionLoopBoundary({
    base,
    mission_id: "MISSION-SCOPE",
    run_id: "RUN-ROOT",
    current_goal_complete: true,
  });
  assert.deepEqual(result.objective.queued_work.map(item => item.constraints), [["first-only constraint"], []]);
  assert.deepEqual(result.continuation.constraints, ["first-only constraint"]);
});

test("legacy launch records without target_alias or constraints still deduplicate", () => {
  const base = tempBase();
  const control = openMissionControl({base, mission_id: "MISSION-LEGACY-LAUNCH", run_id: "RUN-ROOT"});
  const request = {
    parent_run_id: "RUN-ROOT",
    child_run_id: "RUN-CHILD",
    launch_id: "LAUNCH-LEGACY",
    idempotency_key: "legacy-launch-key",
    goal: "legacy child",
  };
  const first = requestMissionChildLaunch(control, request, {
    boundary: {safe: true, pending_action: false, ambiguous_action: false},
  });
  assert.equal(first.deduplicated, false);

  const file = path.join(control.paths.root, "launch-state.json");
  const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
  delete persisted.launches[0].target_alias;
  delete persisted.launches[0].constraints;
  fs.writeFileSync(file, JSON.stringify(persisted, null, 2) + "\n", "utf8");

  const reopened = openMissionControl({base, mission_id: "MISSION-LEGACY-LAUNCH", run_id: "RUN-ROOT"});
  const replay = requestMissionChildLaunch(reopened, request, {
    boundary: {safe: true, pending_action: false, ambiguous_action: false},
  });
  assert.equal(replay.deduplicated, true);
  assert.equal(replay.launch.launch_id, "LAUNCH-LEGACY");
});

test("next_safe_boundary constraint remains pending because live Goal mutation is unsupported", () => {
  const base = tempBase();
  const control = openMissionControl({base, mission_id: "MISSION-LIVE", run_id: "RUN-LIVE"});
  enqueueMissionAmendment(control, {
    amendment_id: "AMEND-LIVE-CONSTRAINT",
    idempotency_key: "live-constraint-1",
    kind: "MISSION_AMENDMENT",
    apply_mode: "next_safe_boundary",
    payload: {constraint: "change the already-running Goal"},
  });

  const result = applyMissionLoopBoundary({
    base,
    mission_id: "MISSION-LIVE",
    run_id: "RUN-LIVE",
    current_goal_complete: false,
  });
  assert.equal(result.applied.length, 0);
  assert.deepEqual(result.skipped, [{amendment_id: "AMEND-LIVE-CONSTRAINT", reason: "UNSUPPORTED_MUTATION_TARGET"}]);
  assert.equal(result.objective.constraints.length, 0);
  const reopened = openMissionControl({base, mission_id: "MISSION-LIVE", run_id: "RUN-LIVE"});
  assert.equal(reopened.amendments.amendments[0].status, "PENDING");
});

test("constraint-only after_current_goal remains pending until a scoped continuation work item exists", () => {
  const base = tempBase();
  const control = openMissionControl({base, mission_id: "MISSION-CONSTRAINT-ONLY", run_id: "RUN-ROOT"});
  enqueueMissionAmendment(control, {
    amendment_id: "AMEND-CONSTRAINT-ONLY",
    idempotency_key: "constraint-only-1",
    kind: "MISSION_AMENDMENT",
    apply_mode: "after_current_goal",
    payload: {constraint: "must not be falsely applied"},
  });

  const result = applyMissionLoopBoundary({
    base,
    mission_id: "MISSION-CONSTRAINT-ONLY",
    run_id: "RUN-ROOT",
    current_goal_complete: true,
  });
  assert.equal(result.applied.length, 0);
  assert.deepEqual(result.skipped, [{amendment_id: "AMEND-CONSTRAINT-ONLY", reason: "UNSUPPORTED_MUTATION_TARGET"}]);
  assert.equal(result.continuation, null);
  const reopened = openMissionControl({base, mission_id: "MISSION-CONSTRAINT-ONLY", run_id: "RUN-ROOT"});
  assert.equal(reopened.amendments.amendments[0].status, "PENDING");
});

test("constraint envelope renders deterministically and rejects malformed transport", () => {
  const constraints = parseMissionConstraintsEnv(JSON.stringify(["read only", "no external publish"]));
  assert.deepEqual(constraints, ["read only", "no external publish"]);
  assert.equal(
    renderMissionGoalWithConstraints("inspect state", constraints),
    "inspect state\n\nDEV EXEC MISSION CONSTRAINTS — apply all of these to this continuation:\n1. read only\n2. no external publish",
  );
  assert.throws(() => parseMissionConstraintsEnv("not-json"), /MISSION_CONSTRAINTS_JSON_INVALID/);
  assert.throws(() => parseMissionConstraintsEnv(JSON.stringify({bad: true})), /MISSION_CONSTRAINTS_ARRAY_REQUIRED/);
});
