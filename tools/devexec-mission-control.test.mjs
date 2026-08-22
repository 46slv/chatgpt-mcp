import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  beginMissionAmendmentApply,
  completeMissionAmendmentApply,
  enqueueMissionAmendment,
  listApplicableMissionAmendments,
  openMissionControl,
} from "./devexec-mission-control.mjs";
import {loadAmendmentQueue} from "./devexec-mission-amendments.mjs";
import {loadMissionState} from "./devexec-mission-state.mjs";

function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-control-"));
  return Promise.resolve(fn(root)).finally(() => fs.rmSync(root, {recursive: true, force: true}));
}

function amendment(overrides = {}) {
  return {
    amendment_id: overrides.amendment_id ?? "AMD-001",
    idempotency_key: overrides.idempotency_key ?? "MISSION-001:operator:001",
    kind: overrides.kind ?? "MISSION_AMENDMENT",
    apply_mode: overrides.apply_mode ?? "next_safe_boundary",
    priority: overrides.priority ?? 10,
    payload: overrides.payload ?? {add_work: "integrate amendment"},
  };
}

test("opening root creates durable mission state and amendment queue", () => withRoot(root => {
  const control = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001", now: "2026-08-23T04:50:00+09:00"});
  assert.equal(control.created, true);
  assert.ok(fs.existsSync(control.paths.state_file));
  assert.ok(fs.existsSync(control.paths.amendments_file));
  assert.equal(loadMissionState(control.paths.state_file).current_run_id, "RUN-001");
  assert.equal(loadAmendmentQueue(control.paths.amendments_file).current_run_id, "RUN-001");
}));

test("reopening current run is deduplicated and a stale root run cannot reclaim current after child attachment", () => withRoot(root => {
  const rootControl = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  const reopened = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  assert.equal(reopened.created, false);
  openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-002", parent_run_id: "RUN-001"});
  assert.throws(
    () => openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"}),
    /STALE_RUN_ID/,
  );
  assert.equal(rootControl.state.root_run_id, "RUN-001");
}));

test("child run carries pending amendment and rejects sibling launch from stale parent", () => withRoot(root => {
  const rootControl = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  enqueueMissionAmendment(rootControl, amendment({apply_mode: "after_current_goal"}));
  const child = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-002", parent_run_id: "RUN-001"});
  assert.equal(child.state.current_run_id, "RUN-002");
  assert.equal(child.amendments.current_run_id, "RUN-002");
  assert.equal(child.amendments.amendments[0].status, "PENDING");
  assert.equal(child.amendments.amendments[0].created_for_run_id, "RUN-001");
  assert.throws(
    () => openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-003", parent_run_id: "RUN-001"}),
    /STALE_PARENT_RUN_ID/,
  );
}));

test("begin apply is durably fenced before mutation completion and survives reopen", () => withRoot(root => {
  const control = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  enqueueMissionAmendment(control, amendment());
  assert.equal(listApplicableMissionAmendments(control, {safe: true})[0].amendment_id, "AMD-001");
  beginMissionAmendmentApply(control, "AMD-001", {safe: true}, {apply_attempt_id: "APPLY-001"});

  const disk = loadAmendmentQueue(control.paths.amendments_file);
  assert.equal(disk.amendments[0].status, "APPLYING");
  assert.equal(disk.amendments[0].apply_attempt_id, "APPLY-001");
  assert.equal(disk.amendments[0].applied_run_id, "RUN-001");

  const reopened = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  assert.deepEqual(listApplicableMissionAmendments(reopened, {safe: true}), []);
  assert.equal(beginMissionAmendmentApply(reopened, "AMD-001", {safe: true}, {apply_attempt_id: "APPLY-001"}).deduplicated, true);
  assert.throws(
    () => beginMissionAmendmentApply(reopened, "AMD-001", {safe: true}, {apply_attempt_id: "APPLY-OTHER"}),
    /AMENDMENT_APPLY_IN_FLIGHT/,
  );
}));

test("only matching apply attempt can durably complete", () => withRoot(root => {
  const control = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  enqueueMissionAmendment(control, amendment());
  beginMissionAmendmentApply(control, "AMD-001", {safe: true}, {apply_attempt_id: "APPLY-001"});
  assert.throws(
    () => completeMissionAmendmentApply(control, "AMD-001", {apply_attempt_id: "APPLY-WRONG"}),
    /AMENDMENT_APPLY_ATTEMPT_MISMATCH/,
  );
  const completed = completeMissionAmendmentApply(control, "AMD-001", {
    apply_attempt_id: "APPLY-001",
    now: "2026-08-23T04:51:00+09:00",
  });
  assert.equal(completed.amendment.status, "APPLIED");
  assert.equal(loadAmendmentQueue(control.paths.amendments_file).amendments[0].status, "APPLIED");
}));
