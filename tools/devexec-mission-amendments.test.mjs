import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyAmendment,
  carryAmendmentsToRun,
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
    () => applyAmendment(queue, "AMD-001", {safe: true, ambiguous_action: true, run_id: "RUN-1"}),
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

test("apply records durable disposition and run identity exactly once", () => {
  const queue = createAmendmentQueue({mission_id: "MISSION-1", run_id: "RUN-1"});
  add(queue);
  const applied = applyAmendment(
    queue,
    "AMD-001",
    {safe: true, pending_action: false, ambiguous_action: false, run_id: "RUN-1"},
    {now: "2026-08-23T04:41:00+09:00"},
  );
  assert.equal(applied.status, "APPLIED");
  assert.equal(applied.applied_run_id, "RUN-1");
  assert.equal(applied.applied_at, "2026-08-23T04:41:00+09:00");
  assert.deepEqual(selectApplicableAmendments(queue, {safe: true, run_id: "RUN-1"}), []);
  assert.throws(
    () => setAmendmentDisposition(queue, "AMD-001", "CANCELLED"),
    /already terminal/,
  );
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
