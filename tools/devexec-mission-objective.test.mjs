import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {applyMissionObjectiveAmendment, normalizeMissionObjectivePayload, readMissionObjective} from "./devexec-mission-objective.mjs";

function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-objective-"));
  return Promise.resolve(fn(root)).finally(() => fs.rmSync(root, {recursive: true, force: true}));
}

function amendment(overrides = {}) {
  return {
    amendment_id: overrides.amendment_id ?? "AMD-001",
    kind: overrides.kind ?? "MISSION_AMENDMENT",
    apply_mode: overrides.apply_mode ?? "next_safe_boundary",
    payload: overrides.payload ?? {add_work: "review current tests"},
  };
}

test("typed Mission add_work amendment produces durable queued work and receipt", () => withRoot(root => {
  const applied = applyMissionObjectiveAmendment({
    base: root,
    mission_id: "MISSION-001",
    amendment: amendment(),
    apply_attempt_id: "APPLY-001",
    now: "2026-08-23T06:00:00+09:00",
  });
  assert.equal(applied.deduplicated, false);
  const state = readMissionObjective({base: root, mission_id: "MISSION-001"});
  assert.deepEqual(state.queued_work.map(x => x.text), ["review current tests"]);
  assert.deepEqual(state.queued_work[0].constraints, []);
  assert.deepEqual(state.constraints, []);
  assert.equal(state.receipts[0].amendment_id, "AMD-001");
  assert.equal(state.receipts[0].apply_attempt_id, "APPLY-001");
}));

test("same amendment attempt is idempotent across restart-style reapplication", () => withRoot(root => {
  const input = {base: root, mission_id: "MISSION-001", amendment: amendment(), apply_attempt_id: "APPLY-001"};
  const first = applyMissionObjectiveAmendment(input);
  const second = applyMissionObjectiveAmendment(input);
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  const state = readMissionObjective({base: root, mission_id: "MISSION-001"});
  assert.equal(state.queued_work.length, 1);
  assert.equal(state.constraints.length, 0);
  assert.equal(state.receipts.length, 1);
}));

test("different attempt or changed payload for an already-applied amendment fails closed", () => withRoot(root => {
  applyMissionObjectiveAmendment({base: root, mission_id: "MISSION-001", amendment: amendment(), apply_attempt_id: "APPLY-001"});
  assert.throws(
    () => applyMissionObjectiveAmendment({base: root, mission_id: "MISSION-001", amendment: amendment(), apply_attempt_id: "APPLY-OTHER"}),
    /MISSION_OBJECTIVE_AMENDMENT_ATTEMPT_CONFLICT/,
  );
  assert.throws(
    () => applyMissionObjectiveAmendment({
      base: root,
      mission_id: "MISSION-001",
      amendment: amendment({payload: {add_work: "changed"}}),
      apply_attempt_id: "APPLY-001",
    }),
    /MISSION_OBJECTIVE_AMENDMENT_PAYLOAD_CONFLICT/,
  );
}));

test("unsupported GOAL_PATCH, supersede mode, live constraints, and unknown payload keys remain unapplied", () => {
  assert.throws(() => normalizeMissionObjectivePayload(amendment({kind: "GOAL_PATCH"})), /UNSUPPORTED_AMENDMENT_KIND/);
  assert.throws(() => normalizeMissionObjectivePayload(amendment({apply_mode: "supersede_current_goal"})), /UNSUPPORTED_APPLY_MODE/);
  assert.throws(() => normalizeMissionObjectivePayload(amendment({payload: {constraint: "must be enforced"}})), /UNSUPPORTED_LIVE_CONSTRAINT_ENFORCEMENT/);
  assert.throws(() => normalizeMissionObjectivePayload(amendment({payload: {add_work: "A", constraints: ["C1", "C2"]}})), /UNSUPPORTED_LIVE_CONSTRAINT_ENFORCEMENT/);
  assert.throws(() => normalizeMissionObjectivePayload(amendment({payload: {replace_running_goal: "unsafe"}})), /UNKNOWN_PAYLOAD_KEYS/);
});

test("after_current_goal work can atomically snapshot scoped constraints", () => withRoot(root => {
  const constrained = amendment({
    apply_mode: "after_current_goal",
    payload: {add_work: ["A", "B"], constraints: ["C1", "C2"]},
  });
  const applied = applyMissionObjectiveAmendment({
    base: root,
    mission_id: "MISSION-001",
    amendment: constrained,
    apply_attempt_id: "APPLY-CONSTRAINED",
  });
  assert.equal(applied.deduplicated, false);
  const state = readMissionObjective({base: root, mission_id: "MISSION-001"});
  assert.deepEqual(state.queued_work.map(item => item.constraints), [["C1", "C2"], ["C1", "C2"]]);
  assert.deepEqual(state.constraints.map(item => item.text), ["C1", "C2"]);
  assert.equal(state.receipts[0].constraint_count, 2);
}));

test("standalone after_current_goal constraint stays unsupported until it has scoped work", () => {
  assert.throws(
    () => normalizeMissionObjectivePayload(amendment({apply_mode: "after_current_goal", payload: {constraint: "C1"}})),
    /UNSUPPORTED_CONSTRAINT_WITHOUT_WORK/,
  );
});

test("array work normalizes deterministically", () => {
  assert.deepEqual(
    normalizeMissionObjectivePayload(amendment({payload: {add_work: ["A", "B"]}})),
    {queued_work: ["A", "B"], constraints: []},
  );
});
