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
    payload: overrides.payload ?? {add_work: "review current tests", constraint: "preserve cache"},
  };
}

test("typed Mission amendment produces durable queued work, constraints, and receipt", () => withRoot(root => {
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
  assert.deepEqual(state.constraints.map(x => x.text), ["preserve cache"]);
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
  assert.equal(state.constraints.length, 1);
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

test("unsupported GOAL_PATCH, supersede mode, and unknown payload keys remain unapplied", () => {
  assert.throws(() => normalizeMissionObjectivePayload(amendment({kind: "GOAL_PATCH"})), /UNSUPPORTED_AMENDMENT_KIND/);
  assert.throws(() => normalizeMissionObjectivePayload(amendment({apply_mode: "supersede_current_goal"})), /UNSUPPORTED_APPLY_MODE/);
  assert.throws(() => normalizeMissionObjectivePayload(amendment({payload: {replace_running_goal: "unsafe"}})), /UNKNOWN_PAYLOAD_KEYS/);
});

test("array work and constraints normalize deterministically", () => {
  assert.deepEqual(
    normalizeMissionObjectivePayload(amendment({payload: {add_work: ["A", "B"], constraints: ["C1", "C2"]}})),
    {queued_work: ["A", "B"], constraints: ["C1", "C2"]},
  );
});
