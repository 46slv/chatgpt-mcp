import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DevExecMissionStore,
  EVENT_STATUSES,
  MissionCoreError,
  OPERATOR_EVENT_PROTOCOL,
  reduceMissionJournal,
} from "./devexec-mission-store.mjs";

const BINDING_A = `sha256:${"a".repeat(64)}`;
const BINDING_B = `sha256:${"b".repeat(64)}`;
const PAYLOAD_A = `sha256:${"1".repeat(64)}`;

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-store-"));
}

function clock(start = Date.parse("2026-09-03T09:00:00.000Z")) {
  let current = start;
  return () => {
    const value = new Date(current);
    current += 1000;
    return value;
  };
}

function operatorEvent({
  eventId = "evt-001",
  requestId = "req-001",
  idempotencyKey = "idem-001",
  kind = "operator.request.submitted",
  missionId = null,
  intent = "TASK",
  authority = intent === "CONSULTATION" ? "READ_ONLY" : "BOUNDED_WRITE",
  binding = BINDING_A,
  payload = PAYLOAD_A,
  correlationId = "corr-001",
  occurredAt = "2026-09-03T18:00:00+09:00",
} = {}) {
  return {
    protocol: OPERATOR_EVENT_PROTOCOL,
    schema_version: 1,
    event_id: eventId,
    request_id: requestId,
    idempotency_key: idempotencyKey,
    kind,
    occurred_at: occurredAt,
    source: { type: "operator", adapter: "mission-console", binding_id: binding },
    subject: { mission_id: missionId },
    intent,
    requested_authority: authority,
    payload_ref: { sha256: payload, location: `runtime-payload/${eventId}` },
    correlation_id: correlationId,
  };
}

function newStore(root, start) {
  return new DevExecMissionStore({ stateDir: root, now: clock(start) });
}

function completePayload(summary = "done") {
  return {
    status: "COMPLETE",
    summary,
    changed_surface: ["tools/devexec-mission-store.mjs"],
    evidence_refs: ["test:devexec-mission-store"],
    remaining_limits: ["HOST ACCEPTANCE REMAINS"],
    episode_aggregate: { episode_count: 0, runtime_classes: [], escalation_count: 0 },
  };
}

test("TASK new Mission produces exact ids, durable lifecycle, and one Mission", () => {
  const root = tmp();
  const store = newStore(root);
  const event = operatorEvent();
  const response = store.submitOperatorEvent(event);

  assert.equal(response.status, "APPLIED");
  assert.equal(response.event_id, event.event_id);
  assert.equal(response.request_id, event.request_id);
  assert.match(response.mission_id, /^mission-[a-f0-9]{32}$/);
  assert.equal(store.listMissions().length, 1);

  const mission = store.readMission(response.mission_id);
  assert.equal(mission.initial_request_id, event.request_id);
  assert.equal(mission.initial_event_id, event.event_id);
  assert.equal(mission.intent, "TASK");
  assert.equal(mission.authority_ceiling, "BOUNDED_WRITE");
  assert.deepEqual(mission.applied_event_ids, [event.event_id]);
  assert.deepEqual(mission.deferred_event_ids, []);

  const records = store.readJournal();
  assert.deepEqual(records.map((record) => record.status), ["RECEIVED", "ACCEPTED", "APPLIED"]);
  assert.equal(store.listEvents().length, 1);
  assert.equal(store.listEvents()[0].status, "APPLIED");
  assert.equal(store.verifyDurableState().valid, true);
});

test("CONSULTATION new Mission is read-only and independent", () => {
  const root = tmp();
  const store = newStore(root);
  const response = store.submitOperatorEvent(operatorEvent({
    eventId: "evt-consult",
    requestId: "req-consult",
    idempotencyKey: "idem-consult",
    intent: "CONSULTATION",
    authority: "READ_ONLY",
  }));
  assert.equal(response.status, "APPLIED");
  const mission = store.readMission(response.mission_id);
  assert.equal(mission.intent, "CONSULTATION");
  assert.equal(mission.authority_ceiling, "READ_ONLY");
});

test("same idempotency submission is DUPLICATE and creates no second work", async () => {
  const root = tmp();
  const store = newStore(root);
  const event = operatorEvent({ eventId: "evt-dupe", requestId: "req-dupe", idempotencyKey: "idem-dupe" });
  const first = store.submitOperatorEvent(event);
  const journalCount = store.readJournal().length;
  const second = store.submitOperatorEvent(event);

  assert.equal(first.status, "APPLIED");
  assert.equal(second.status, "DUPLICATE");
  assert.equal(second.canonical_status, "APPLIED");
  assert.equal(second.mission_id, first.mission_id);
  assert.equal(store.listMissions().length, 1);
  assert.equal(store.listEvents().length, 1);
  assert.equal(store.readJournal().length, journalCount + 1);
  assert.equal(store.listEvents()[0].status, "APPLIED");
  assert.equal(store.listEvents()[0].duplicate_count, 1);

  const attempts = await Promise.all(Array.from({ length: 24 }, () => Promise.resolve().then(() => store.submitOperatorEvent(event))));
  assert.equal(attempts.filter((item) => item.status === "DUPLICATE").length, 24);
  assert.equal(store.listMissions().length, 1);
  assert.equal(store.listEvents()[0].duplicate_count, 25);
  assert.equal(store.readJournal().length, journalCount + 25);
});

test("idempotency key reuse with changed payload is BLOCKED", () => {
  const root = tmp();
  const store = newStore(root);
  const original = operatorEvent({ eventId: "evt-conflict", requestId: "req-conflict", idempotencyKey: "idem-conflict" });
  const first = store.submitOperatorEvent(original);
  const conflicting = operatorEvent({
    eventId: "evt-conflict-2",
    requestId: "req-conflict-2",
    idempotencyKey: "idem-conflict",
    correlationId: "corr-conflict-2",
  });
  const second = store.submitOperatorEvent(conflicting);
  assert.equal(first.status, "APPLIED");
  assert.equal(second.status, "BLOCKED");
  assert.equal(second.reason_code, "IDEMPOTENCY_CONFLICT");
  assert.equal(store.listMissions().length, 1);
});

test("malformed and unsupported schemas reject before Mission side effects", () => {
  const root = tmp();
  const store = newStore(root);
  const unsupported = { ...operatorEvent(), schema_version: 2 };
  const unknown = { ...operatorEvent({ eventId: "evt-extra", requestId: "req-extra", idempotencyKey: "idem-extra" }), extra: true };

  assert.equal(store.submitOperatorEvent(unsupported).status, "REJECTED");
  assert.equal(store.submitOperatorEvent(unsupported).reason_code, "UNSUPPORTED_SCHEMA_VERSION");
  assert.equal(store.submitOperatorEvent(unknown).status, "REJECTED");
  assert.equal(store.readJournal().length, 0);
  assert.equal(store.listMissions().length, 0);
  assert.equal(store.listIdempotencyReceipts().length, 0);
});

test("authority contradiction is persisted as BLOCKED without a Mission", () => {
  const root = tmp();
  const store = newStore(root);
  const response = store.submitOperatorEvent(operatorEvent({
    eventId: "evt-blocked",
    requestId: "req-blocked",
    idempotencyKey: "idem-blocked",
    intent: "CONSULTATION",
    authority: "BOUNDED_WRITE",
  }));
  assert.equal(response.status, "BLOCKED");
  assert.equal(response.reason_code, "CONSULTATION_AUTHORITY_CONTRADICTION");
  assert.deepEqual(store.readJournal().map((record) => record.status), ["RECEIVED", "BLOCKED"]);
  assert.equal(store.listMissions().length, 0);
});

test("follow-up requires an exact existing mission_id", () => {
  const root = tmp();
  const store = newStore(root);
  const missing = operatorEvent({
    eventId: "evt-follow-missing",
    requestId: "req-follow-missing",
    idempotencyKey: "idem-follow-missing",
    kind: "operator.followup.submitted",
    missionId: null,
    authority: "READ_ONLY",
  });
  const missingReceipt = store.submitOperatorEvent(missing);
  assert.equal(missingReceipt.status, "REJECTED");
  assert.equal(missingReceipt.reason_code, "MISSION_ID_REQUIRED");

  const wrong = operatorEvent({
    eventId: "evt-follow-wrong",
    requestId: "req-follow-wrong",
    idempotencyKey: "idem-follow-wrong",
    kind: "operator.followup.submitted",
    missionId: "mission-does-not-exist",
    authority: "READ_ONLY",
  });
  const wrongReceipt = store.submitOperatorEvent(wrong);
  assert.equal(wrongReceipt.status, "REJECTED");
  assert.equal(wrongReceipt.reason_code, "MISSION_NOT_FOUND");
  assert.deepEqual(store.readJournal().map((record) => record.status), ["RECEIVED", "REJECTED"]);
  assert.equal(store.listMissions().length, 0);
});

test("Mission A/B follow-up routing cannot cross and apply seam is exact", () => {
  const root = tmp();
  const store = newStore(root);
  const a = store.submitOperatorEvent(operatorEvent({ eventId: "evt-a", requestId: "req-a", idempotencyKey: "idem-a" }));
  const b = store.submitOperatorEvent(operatorEvent({ eventId: "evt-b", requestId: "req-b", idempotencyKey: "idem-b", binding: BINDING_B }));
  const follow = operatorEvent({
    eventId: "evt-a-follow",
    requestId: "req-a-follow",
    idempotencyKey: "idem-a-follow",
    kind: "operator.followup.submitted",
    missionId: a.mission_id,
    authority: "READ_ONLY",
    correlationId: "corr-a-follow",
  });
  const deferred = store.submitOperatorEvent(follow);
  assert.equal(deferred.status, "DEFERRED");
  assert.deepEqual(store.readMission(a.mission_id).deferred_event_ids, [follow.event_id]);
  assert.deepEqual(store.readMission(b.mission_id).deferred_event_ids, []);

  assert.throws(
    () => store.applyDeferredEvent({ mission_id: b.mission_id, event_id: follow.event_id, safe_boundary: "FRESH_NEXT_EPISODE" }),
    (error) => error instanceof MissionCoreError && error.code === "EVENT_MISSION_MISMATCH",
  );
  assert.deepEqual(store.readMission(b.mission_id).applied_event_ids, ["evt-b"]);
});

test("deferred follow-up persists across restart then applies only at fresh-next-episode seam", () => {
  const root = tmp();
  const store = newStore(root);
  const created = store.submitOperatorEvent(operatorEvent({ eventId: "evt-restart", requestId: "req-restart", idempotencyKey: "idem-restart" }));
  const follow = operatorEvent({
    eventId: "evt-restart-follow",
    requestId: "req-restart-follow",
    idempotencyKey: "idem-restart-follow",
    kind: "operator.followup.submitted",
    missionId: created.mission_id,
    authority: "READ_ONLY",
  });
  assert.equal(store.submitOperatorEvent(follow).status, "DEFERRED");

  const reopened = newStore(root, Date.parse("2026-09-03T10:00:00.000Z"));
  assert.equal(reopened.verifyDurableState().valid, true);
  assert.equal(reopened.readEvent(follow.event_id).status, "DEFERRED");
  assert.deepEqual(reopened.readMission(created.mission_id).deferred_event_ids, [follow.event_id]);
  assert.throws(
    () => reopened.applyDeferredEvent({ mission_id: created.mission_id, event_id: follow.event_id, safe_boundary: "ACTIVE_EPISODE_INJECTION" }),
    (error) => error instanceof MissionCoreError && error.code === "SAFE_BOUNDARY_REQUIRED",
  );

  const applied = reopened.applyDeferredEvent({ mission_id: created.mission_id, event_id: follow.event_id, safe_boundary: "FRESH_NEXT_EPISODE" });
  assert.equal(applied.status, "APPLIED");
  const mission = reopened.readMission(created.mission_id);
  assert.deepEqual(mission.deferred_event_ids, []);
  assert.deepEqual(mission.applied_event_ids, ["evt-restart", follow.event_id]);
  assert.equal(mission.followups.length, 1);

  const reopenedAgain = newStore(root, Date.parse("2026-09-03T11:00:00.000Z"));
  assert.equal(reopenedAgain.readEvent(follow.event_id).status, "APPLIED");
  assert.equal(reopenedAgain.listIdempotencyReceipts().find((item) => item.event_id === follow.event_id).status, "APPLIED");
});

test("parent-owned reducer is deterministic for identical durable evidence", () => {
  const root = tmp();
  const store = newStore(root);
  const created = store.submitOperatorEvent(operatorEvent({ eventId: "evt-det", requestId: "req-det", idempotencyKey: "idem-det" }));
  const follow = operatorEvent({
    eventId: "evt-det-follow",
    requestId: "req-det-follow",
    idempotencyKey: "idem-det-follow",
    kind: "operator.followup.submitted",
    missionId: created.mission_id,
    authority: "READ_ONLY",
  });
  store.submitOperatorEvent(follow);
  store.applyDeferredEvent({ mission_id: created.mission_id, event_id: follow.event_id, safe_boundary: "FRESH_NEXT_EPISODE" });
  const records = store.readJournal();
  const first = [...reduceMissionJournal(records).entries()];
  const second = [...reduceMissionJournal(records).entries()];
  assert.deepEqual(first, second);
  assert.deepEqual(first[0][1], store.readMission(created.mission_id));
});

test("exactly one canonical MissionResult is committed and duplicate completion does not create another", () => {
  const root = tmp();
  const store = newStore(root);
  const created = store.submitOperatorEvent(operatorEvent({ eventId: "evt-result", requestId: "req-result", idempotencyKey: "idem-result" }));
  const payload = completePayload();
  const first = store.completeMission(created.mission_id, payload);
  assert.equal(first.status, "COMMITTED");
  assert.equal(first.duplicate, false);
  assert.match(first.result.result_id, /^result-[a-f0-9]{32}$/);

  const second = store.completeMission(created.mission_id, payload);
  assert.equal(second.status, "DUPLICATE");
  assert.equal(second.duplicate, true);
  assert.equal(second.result.result_id, first.result.result_id);
  assert.deepEqual(store.readMissionResult(created.mission_id), first.result);
  assert.equal(store.readMission(created.mission_id).result_id, first.result.result_id);
  assert.equal(fs.readdirSync(path.join(root, "missions", created.mission_id)).filter((name) => name === "result.json").length, 1);

  assert.throws(
    () => store.completeMission(created.mission_id, completePayload("different terminal answer")),
    (error) => error instanceof MissionCoreError && error.code === "MISSION_RESULT_CONFLICT",
  );
  assert.equal(store.readMissionResult(created.mission_id).result_id, first.result.result_id);
});

test("canonical MissionResult survives restart with exact identity", () => {
  const root = tmp();
  const store = newStore(root);
  const created = store.submitOperatorEvent(operatorEvent({ eventId: "evt-result-restart", requestId: "req-result-restart", idempotencyKey: "idem-result-restart" }));
  const first = store.completeMission(created.mission_id, completePayload("restart result"));
  const reopened = newStore(root, Date.parse("2026-09-03T12:00:00.000Z"));
  assert.equal(reopened.verifyDurableState().valid, true);
  assert.equal(reopened.readMissionResult(created.mission_id).result_id, first.result.result_id);
  assert.equal(reopened.readMission(created.mission_id).status, "COMPLETE");
});

test("valid stale snapshot is reconstructed from authoritative journal after restart", () => {
  const root = tmp();
  const store = newStore(root);
  const created = store.submitOperatorEvent(operatorEvent({ eventId: "evt-stale", requestId: "req-stale", idempotencyKey: "idem-stale" }));
  const snapshotPath = path.join(root, "missions", created.mission_id, "snapshot.json");
  const original = fs.readFileSync(snapshotPath, "utf8");
  const follow = operatorEvent({
    eventId: "evt-stale-follow",
    requestId: "req-stale-follow",
    idempotencyKey: "idem-stale-follow",
    kind: "operator.followup.submitted",
    missionId: created.mission_id,
    authority: "READ_ONLY",
  });
  store.submitOperatorEvent(follow);
  // Simulate a crash after durable journal admission but before the atomic
  // projection replacement by restoring the older, internally valid snapshot.
  fs.writeFileSync(snapshotPath, original, "utf8");
  const reopened = newStore(root, Date.parse("2026-09-03T13:00:00.000Z"));
  assert.equal(reopened.verifyDurableState().classification, "STALE_MISSION_SNAPSHOT");
  const recovered = reopened.readMission(created.mission_id);
  assert.deepEqual(recovered.deferred_event_ids, [follow.event_id]);
  assert.equal(reopened.verifyDurableState().valid, true);
});

test("corrupted snapshot and incomplete journal fail closed", () => {
  const root = tmp();
  const store = newStore(root);
  const created = store.submitOperatorEvent(operatorEvent({ eventId: "evt-corrupt", requestId: "req-corrupt", idempotencyKey: "idem-corrupt" }));
  const snapshotPath = path.join(root, "missions", created.mission_id, "snapshot.json");
  fs.writeFileSync(snapshotPath, "{not-json\n", "utf8");
  const reopened = newStore(root, Date.parse("2026-09-03T14:00:00.000Z"));
  const verification = reopened.verifyDurableState();
  assert.equal(verification.valid, false);
  assert.equal(verification.classification, "CORRUPT_MISSION_SNAPSHOT");
  assert.throws(() => reopened.readMission(created.mission_id), MissionCoreError);

  const journalRoot = tmp();
  const journalStore = newStore(journalRoot);
  journalStore.submitOperatorEvent(operatorEvent({ eventId: "evt-journal", requestId: "req-journal", idempotencyKey: "idem-journal" }));
  fs.writeFileSync(path.join(journalRoot, "event-journal", "00000004.json"), "{partial", "utf8");
  const journalVerification = journalStore.verifyDurableState();
  assert.equal(journalVerification.valid, false);
  assert.equal(journalVerification.classification, "CORRUPT_EVENT_JOURNAL");
  const blocked = journalStore.submitOperatorEvent(operatorEvent({ eventId: "evt-after-corrupt", requestId: "req-after-corrupt", idempotencyKey: "idem-after-corrupt" }));
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.reason_code, "CORRUPT_EVENT_JOURNAL");
});

test("incomplete idempotency claim is fail-closed and prevents replay", () => {
  const root = tmp();
  const store = newStore(root);
  const event = operatorEvent({ eventId: "evt-pending", requestId: "req-pending", idempotencyKey: "idem-pending" });
  // Inject a crash-equivalent write failure only after the exclusive
  // idempotency claim has been created. This leaves PENDING evidence without
  // an Event journal record, which must never be replayed automatically.
  const originalOpenSync = fs.openSync;
  fs.openSync = function injectedOpenSync(file, flags, ...rest) {
    if (String(file).includes(`${path.sep}event-journal${path.sep}00000001.json`) && flags === "wx") {
      const error = new Error("injected journal write failure");
      error.code = "EIO";
      throw error;
    }
    return originalOpenSync.call(fs, file, flags, ...rest);
  };
  try { assert.throws(() => store.submitOperatorEvent(event), /injected journal write failure/); }
  finally { fs.openSync = originalOpenSync; }

  const verification = store.verifyDurableState();
  assert.equal(verification.valid, false);
  assert.equal(verification.classification, "INCOMPLETE_IDEMPOTENCY_CLAIM");
  const retry = store.submitOperatorEvent(event);
  assert.equal(retry.status, "BLOCKED");
  assert.equal(retry.reason_code, "IDEMPOTENCY_IN_FLIGHT");
  assert.equal(store.readJournal().length, 0);
});

test("all operator event lifecycle outcomes remain mechanically distinct", () => {
  assert.deepEqual(EVENT_STATUSES, ["RECEIVED", "ACCEPTED", "DEFERRED", "APPLIED", "DUPLICATE", "REJECTED", "BLOCKED"]);

  const root = tmp();
  const store = newStore(root);
  const createdEvent = operatorEvent({ eventId: "evt-states", requestId: "req-states", idempotencyKey: "idem-states" });
  const created = store.submitOperatorEvent(createdEvent);
  const duplicate = store.submitOperatorEvent(createdEvent);
  const follow = store.submitOperatorEvent(operatorEvent({
    eventId: "evt-states-follow",
    requestId: "req-states-follow",
    idempotencyKey: "idem-states-follow",
    kind: "operator.followup.submitted",
    missionId: created.mission_id,
    authority: "READ_ONLY",
  }));
  const rejected = store.submitOperatorEvent({ ...operatorEvent({ eventId: "evt-states-reject", requestId: "req-states-reject", idempotencyKey: "idem-states-reject" }), schema_version: 99 });
  const blocked = store.submitOperatorEvent(operatorEvent({
    eventId: "evt-states-block",
    requestId: "req-states-block",
    idempotencyKey: "idem-states-block",
    intent: "CONSULTATION",
    authority: "BOUNDED_WRITE",
  }));

  assert.equal(created.status, "APPLIED");
  assert.equal(duplicate.status, "DUPLICATE");
  assert.equal(follow.status, "DEFERRED");
  assert.equal(rejected.status, "REJECTED");
  assert.equal(blocked.status, "BLOCKED");
  const persisted = new Set(store.readJournal().map((record) => record.status));
  assert.equal(persisted.has("RECEIVED"), true);
  assert.equal(persisted.has("ACCEPTED"), true);
  assert.equal(persisted.has("DEFERRED"), true);
  assert.equal(persisted.has("APPLIED"), true);
  assert.equal(persisted.has("BLOCKED"), true);
});

test("structured read APIs expose bounded Mission/Event/Result projections", () => {
  const root = tmp();
  const store = newStore(root);
  const created = store.submitOperatorEvent(operatorEvent({ eventId: "evt-read", requestId: "req-read", idempotencyKey: "idem-read" }));
  const result = store.completeMission(created.mission_id, completePayload("structured"));
  assert.equal(store.listMissions()[0].mission_id, created.mission_id);
  assert.equal(store.listEvents({ missionId: created.mission_id })[0].event_id, "evt-read");
  assert.equal(store.readEvent("evt-read").mission_id, created.mission_id);
  assert.equal(store.readMissionResult(created.mission_id).result_id, result.result.result_id);
  assert.equal(store.listIdempotencyReceipts()[0].mission_id, created.mission_id);
});
