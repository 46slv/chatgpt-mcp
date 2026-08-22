import assert from "node:assert/strict";
import test from "node:test";

import {
  carryAmendmentsToRun,
  createAmendmentQueue,
  enqueueAmendment,
  setAmendmentDisposition,
} from "./devexec-mission-amendments.mjs";

function amendment(overrides = {}) {
  return {
    amendment_id: overrides.amendment_id ?? "AMD-001",
    idempotency_key: overrides.idempotency_key ?? "MISSION-001:operator:001",
    kind: overrides.kind ?? "MISSION_AMENDMENT",
    apply_mode: overrides.apply_mode ?? "next_safe_boundary",
    priority: overrides.priority ?? 10,
    payload: overrides.payload ?? {add_work: "A"},
    ...(overrides.run_id === undefined ? {} : {run_id: overrides.run_id}),
  };
}

test("same operator delivery deduplicates after child-run carry without changing origin metadata", () => {
  const queue = createAmendmentQueue({mission_id: "MISSION-001", run_id: "RUN-001"});
  enqueueAmendment(queue, amendment());
  carryAmendmentsToRun(queue, "RUN-002");

  const redelivery = enqueueAmendment(queue, amendment({amendment_id: "AMD-REDELIVERED"}));
  assert.equal(redelivery.deduplicated, true);
  assert.equal(redelivery.amendment.amendment_id, "AMD-001");
  assert.equal(redelivery.amendment.created_for_run_id, "RUN-001");
  assert.equal(queue.amendments.length, 1);
});

test("manual APPLIED disposition cannot bypass the two-phase apply fence", () => {
  const queue = createAmendmentQueue({mission_id: "MISSION-001", run_id: "RUN-001"});
  enqueueAmendment(queue, amendment());
  const revisionBefore = queue.revision;

  assert.throws(
    () => setAmendmentDisposition(queue, "AMD-001", "APPLIED"),
    /APPLIED_REQUIRES_TWO_PHASE_APPLY/,
  );
  assert.equal(queue.amendments[0].status, "PENDING");
  assert.equal(queue.amendments[0].apply_attempt_id, null);
  assert.equal(queue.revision, revisionBefore);
});
