import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyAmendment,
  beginAmendmentApply,
  carryAmendmentsToRun,
  completeAmendmentApply,
  createAmendmentQueue,
  enqueueAmendment,
  loadAmendmentQueue,
  saveAmendmentQueue,
  selectApplicableAmendments,
  setAmendmentDisposition,
} from "./devexec-mission-amendments.mjs";

function add(queue, overrides = {}) {
  return enqueueAmendment(queue, {
    amendment_id: overrides.amendment_id ?? "AMD-001",
    idempotency_key: overrides.idempotency_key ?? "mission-1:operator:001",
    kind: overrides.kind ?? "MISSION_AMENDMENT",
    apply_mode: overrides.apply_mode ?? "next_safe_boundary",
    priority: overrides.priority ?? 10,
    payload: overrides.payload ?? {add_work: "review current tests"},
    run_id: overrides.run_id,
  }, {now: overrides.now ?? "2026-08-23T04:40:00+09:00"});
}

const SAFE_BOUNDARY = {safe: true, pending_action: false, ambiguous_action: false, run_id: "RUN-1"};

test("idempotency key deduplicates repeated operator delivery without revision churn", () => {
  const queue = createAmendmentQueue({mission_id: "MISSION-1", run_id: "RUN-1"});
  const first = add(queue);
  const second = add(queue, {amendment_id: "AMD-REDELIVERED"});
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(second.amendment.amendment_id, "AMD-001");
  assert.equal(queue.amendments.length, 1);
  assert.equal(queue.revision, 1);
});

test("same idempotency key with changed semantic request fails closed", () => {
  const queue = createAmendmentQueue({mission_id: "MISSION-1", run_id: "RUN-1"});
  add(queue, {payload: {add_work: "A"}});
  assert.throws(
    () => add(queue, {amendment_id: "AMD-REUSED", payload: {add_work: "B"}}),
    /IDEMPOTENCY_KEY_CONFLICT/,
  );
  assert.equal(queue.amendments.length, 1);
  assert.equal(queue.revision, 1);
});

test("object key order does not create a false idempotency conflict", () => {
  const queue = createAmendmentQueue({mission_id: "MISSION-1", run_id: "RUN-1"});
  add(queue, {payload: {constraint: "safe", add_work: "A"}});
  const second = add(queue, {amendment_id: "AMD-REDELIVERED", payload: {add_work: "A", constraint: "safe"}});
  assert.equal(second.deduplicated, true);
  assert.equal(queue.amendments.length, 1);
});

test("unsafe, pending-action, and ambiguous-action boundaries never expose amendments for apply", () => {
  const queue = createAmendmentQueue({mission_id: "MISSION-1", run_id: "RUN-1"});
  add(queue);
  assert.deepEqual(selectApplicableAmendments(queue, {safe: false, run_id: "RUN-1"}), []);
  assert.deepEqual(selectApplicableAmendments(queue, {safe: true, pending_action: true, run_id: "RUN-1"}), []);
  assert.deepEqual(selectApplicableAmendments(queue, {safe: true, ambiguous_action: true, run_id: "RUN-1"}), []);
  assert.throws(
    () => beginAmendmentApply(queue, "AMD-001", {safe: true, ambiguous_action: true, run_id: "RUN-1"}, {apply_attempt_id: "APPLY-1"}),
    /not applicable/,
  );
});

test("after_current_goal waits for goal completion while next-safe and supersede can apply at a safe decision boundary", () => {
  const queue = createAmendmentQueue({mission_id: "MISSION-1", run_id: "RUN-1"});
  add(queue, {amendment_id: "AMD-NEXT", idempotency_key: "key-next", apply_mode: "next_safe_boundary", priority: 3});
  add(queue, {amendment_id: "AMD-AFTER", idempotency_key: "key-after", apply_mode: "after_current_goal", priority: 20});
  add(queue, {amendment_id: "AMD-SUPERSEDE", idempotency_key: "key-super", apply_mode: "supersede_current_goal", priority: 10});

  assert.deepEqual(
    selectApplicableAmendments(queue, {safe: true, run_id: "RUN-1", current_goal_complete: false}).map(x => x.amendment_id),
    ["AMD-SUPERSEDE", "AMD-NEXT"],
  );
  assert.deepEqual(
    selectApplicableAmendments(queue, {safe: true, run_id: "RUN-1", current_goal_complete: true}).map(x => x.amendment_id),
    ["AMD-AFTER", "AMD-SUPERSEDE", "AMD-NEXT"],
  );
});

test("two-phase apply fence persists APPLYING before mutation completion and blocks reselection", () => {
  const queue = createAmendmentQueue({mission_id: "MISSION-1", run_id: "RUN-1"});
  add(queue);
  const started = beginAmendmentApply(queue, "AMD-001", SAFE_BOUNDARY, {
    apply_attempt_id: "APPLY-001",
    now: "2026-08-23T04:41:00+09:00",
  });
  assert.equal(started.deduplicated, false);
  assert.equal(started.amendment.status, "APPLYING");
  assert.equal(started.amendment.apply_attempt_id, "APPLY-001");
  assert.equal(started.amendment.applied_run_id, "RUN-1");
  assert.deepEqual(selectApplicableAmendments(queue, SAFE_BOUNDARY), []);
  const repeated = beginAmendmentApply(queue, "AMD-001", SAFE_BOUNDARY, {apply_attempt_id: "APPLY-001"});
  assert.equal(repeated.deduplicated, true);
  assert.throws(
    () => beginAmendmentApply(queue, "AMD-001", SAFE_BOUNDARY, {apply_attempt_id: "APPLY-OTHER"}),
    /AMENDMENT_APPLY_IN_FLIGHT/,
  );
  assert.throws(() => setAmendmentDisposition(queue, "AMD-001", "CANCELLED"), /in flight/);
});

test("two-phase apply survives restart and only matching attempt can complete", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-amendment-apply-"));
  const file = path.join(root, "amendments.json");
  try {
    const queue = createAmendmentQueue({mission_id: "MISSION-1", run_id: "RUN-1"});
    add(queue);
    beginAmendmentApply(queue, "AMD-001", SAFE_BOUNDARY, {apply_attempt_id: "APPLY-001"});
    saveAmendmentQueue(file, queue);

    const restarted = loadAmendmentQueue(file);
    assert.equal(restarted.amendments[0].status, "APPLYING");
    assert.throws(
      () => completeAmendmentApply(restarted, "AMD-001", {apply_attempt_id: "APPLY-WRONG"}),
      /AMENDMENT_APPLY_ATTEMPT_MISMATCH/,
    );
    const completed = completeAmendmentApply(restarted, "AMD-001", {
      apply_attempt_id: "APPLY-001",
      now: "2026-08-23T04:42:00+09:00",
    });
    assert.equal(completed.deduplicated, false);
    assert.equal(completed.amendment.status, "APPLIED");
    assert.equal(completed.amendment.applied_at, "2026-08-23T04:42:00+09:00");
    assert.equal(completeAmendmentApply(restarted, "AMD-001", {apply_attempt_id: "APPLY-001"}).deduplicated, true);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test("legacy one-step apply remains deterministic for non-side-effecting callers", () => {
  const queue = createAmendmentQueue({mission_id: "MISSION-1", run_id: "RUN-1"});
  add(queue);
  const applied = applyAmendment(queue, "AMD-001", SAFE_BOUNDARY, {now: "2026-08-23T04:41:00+09:00"});
  assert.equal(applied.status, "APPLIED");
  assert.equal(applied.applied_run_id, "RUN-1");
  assert.equal(applied.applied_at, "2026-08-23T04:41:00+09:00");
  assert.deepEqual(selectApplicableAmendments(queue, SAFE_BOUNDARY), []);
  assert.throws(() => setAmendmentDisposition(queue, "AMD-001", "CANCELLED"), /already terminal/);
});

test("pending amendments survive atomic save/load and carry into a child run", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-amendments-"));
  const file = path.join(root, "mission", "amendments.json");
  try {
    const queue = createAmendmentQueue({mission_id: "MISSION-1", run_id: "RUN-1"});
    add(queue, {apply_mode: "after_current_goal", payload: {constraint: "preserve current cache"}});
    saveAmendmentQueue(file, queue);

    const restarted = loadAmendmentQueue(file);
    carryAmendmentsToRun(restarted, "RUN-2");
    saveAmendmentQueue(file, restarted);
    const child = loadAmendmentQueue(file);

    assert.equal(child.current_run_id, "RUN-2");
    assert.equal(child.amendments[0].status, "PENDING");
    assert.deepEqual(child.amendments[0].payload, {constraint: "preserve current cache"});
    assert.equal(child.amendments[0].created_for_run_id, "RUN-1");
    assert.equal(
      selectApplicableAmendments(child, {safe: true, run_id: "RUN-2", current_goal_complete: true})[0].target_run_id,
      "RUN-2",
    );
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test("rejected or cancelled amendments remain auditable but cannot be selected", () => {
  const queue = createAmendmentQueue({mission_id: "MISSION-1", run_id: "RUN-1"});
  add(queue, {amendment_id: "AMD-REJECT", idempotency_key: "key-reject"});
  add(queue, {amendment_id: "AMD-CANCEL", idempotency_key: "key-cancel"});
  setAmendmentDisposition(queue, "AMD-REJECT", "REJECTED", {reason: "authority mismatch"});
  setAmendmentDisposition(queue, "AMD-CANCEL", "CANCELLED", {reason: "operator withdrew"});
  assert.equal(queue.amendments[0].disposition_reason, "authority mismatch");
  assert.equal(queue.amendments[1].disposition_reason, "operator withdrew");
  assert.deepEqual(selectApplicableAmendments(queue, {safe: true, run_id: "RUN-1"}), []);
});
