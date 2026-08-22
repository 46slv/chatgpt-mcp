import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  beginMissionAmendmentApply,
  enqueueMissionAmendment,
  openMissionControl,
} from "./devexec-mission-control.mjs";
import {
  applyApplicableMissionObjectiveAmendments,
  reconcileApplyingMissionObjectiveAmendments,
} from "./devexec-mission-amendment-runtime.mjs";
import {applyMissionObjectiveAmendment, readMissionObjective} from "./devexec-mission-objective.mjs";
import {loadAmendmentQueue} from "./devexec-mission-amendments.mjs";

function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-amendment-runtime-"));
  return Promise.resolve(fn(root)).finally(() => fs.rmSync(root, {recursive: true, force: true}));
}

function add(control, overrides = {}) {
  return enqueueMissionAmendment(control, {
    amendment_id: overrides.amendment_id ?? "AMD-001",
    idempotency_key: overrides.idempotency_key ?? "key-001",
    kind: overrides.kind ?? "MISSION_AMENDMENT",
    apply_mode: overrides.apply_mode ?? "next_safe_boundary",
    priority: overrides.priority ?? 10,
    payload: overrides.payload ?? {add_work: "continue implementation"},
  }).amendment;
}

const SAFE = {safe: true, pending_action: false, ambiguous_action: false, current_goal_complete: false};

test("applicable Mission amendment commits objective receipt before APPLIED", () => withRoot(root => {
  const control = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  add(control);
  const result = applyApplicableMissionObjectiveAmendments(control, SAFE, {
    base: root,
    attempt_id_factory: () => "APPLY-001",
    now: "2026-08-23T06:05:00+09:00",
  });
  assert.equal(result.applied.length, 1);
  assert.equal(result.skipped.length, 0);
  const objective = readMissionObjective({base: root, mission_id: "MISSION-001"});
  assert.deepEqual(objective.queued_work.map(x => x.text), ["continue implementation"]);
  assert.equal(objective.receipts[0].apply_attempt_id, "APPLY-001");
  const queue = loadAmendmentQueue(control.paths.amendments_file);
  assert.equal(queue.amendments[0].status, "APPLIED");
}));

test("restart reconciliation completes APPLYING after objective receipt without duplicate mutation", () => withRoot(root => {
  const control = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  const amendment = add(control);
  beginMissionAmendmentApply(control, amendment.amendment_id, SAFE, {apply_attempt_id: "APPLY-001"});
  applyMissionObjectiveAmendment({base: root, mission_id: "MISSION-001", amendment, apply_attempt_id: "APPLY-001"});

  const restarted = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  const result = reconcileApplyingMissionObjectiveAmendments(restarted, {base: root});
  assert.equal(result.reconciled.length, 1);
  assert.equal(result.reconciled[0].mutation.deduplicated, true);
  const objective = readMissionObjective({base: root, mission_id: "MISSION-001"});
  assert.equal(objective.queued_work.length, 1);
  assert.equal(objective.receipts.length, 1);
  assert.equal(loadAmendmentQueue(restarted.paths.amendments_file).amendments[0].status, "APPLIED");
}));

test("restart reconciliation safely performs missing idempotent objective mutation for an APPLYING fence", () => withRoot(root => {
  const control = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  const amendment = add(control);
  beginMissionAmendmentApply(control, amendment.amendment_id, SAFE, {apply_attempt_id: "APPLY-001"});

  const restarted = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  const result = reconcileApplyingMissionObjectiveAmendments(restarted, {base: root});
  assert.equal(result.reconciled.length, 1);
  assert.equal(result.reconciled[0].mutation.deduplicated, false);
  assert.equal(readMissionObjective({base: root, mission_id: "MISSION-001"}).queued_work.length, 1);
  assert.equal(loadAmendmentQueue(restarted.paths.amendments_file).amendments[0].status, "APPLIED");
}));

test("GOAL_PATCH and supersede remain PENDING instead of falsely APPLIED", () => withRoot(root => {
  const control = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  add(control, {amendment_id: "AMD-GOAL", idempotency_key: "key-goal", kind: "GOAL_PATCH", payload: {goal: "new goal"}});
  add(control, {amendment_id: "AMD-SUPER", idempotency_key: "key-super", apply_mode: "supersede_current_goal"});
  const result = applyApplicableMissionObjectiveAmendments(control, SAFE, {base: root});
  assert.equal(result.applied.length, 0);
  assert.deepEqual(result.skipped.map(x => x.amendment_id).sort(), ["AMD-GOAL", "AMD-SUPER"]);
  const queue = loadAmendmentQueue(control.paths.amendments_file);
  assert.deepEqual(queue.amendments.map(x => x.status), ["PENDING", "PENDING"]);
}));

test("after_current_goal is only applied when completion evidence is true", () => withRoot(root => {
  const control = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  add(control, {apply_mode: "after_current_goal"});
  assert.equal(applyApplicableMissionObjectiveAmendments(control, SAFE, {base: root}).applied.length, 0);
  const result = applyApplicableMissionObjectiveAmendments(control, {...SAFE, current_goal_complete: true}, {
    base: root,
    attempt_id_factory: () => "APPLY-AFTER",
  });
  assert.equal(result.applied.length, 1);
  assert.equal(loadAmendmentQueue(control.paths.amendments_file).amendments[0].status, "APPLIED");
}));
