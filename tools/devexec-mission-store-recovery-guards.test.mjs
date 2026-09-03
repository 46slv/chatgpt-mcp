import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DevExecMissionStore,
  MissionCoreError,
  OPERATOR_EVENT_PROTOCOL,
} from "./devexec-mission-store.mjs";
import { DevExecMissionStore as CoreDevExecMissionStore } from "./devexec-mission-store-core.mjs";

const BINDING = `sha256:${"d".repeat(64)}`;
const PAYLOAD = `sha256:${"3".repeat(64)}`;

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-store-guard-"));
}

function operatorEvent({
  eventId,
  requestId,
  idempotencyKey,
  kind = "operator.request.submitted",
  missionId = null,
  authority = "BOUNDED_WRITE",
  correlationId,
} = {}) {
  return {
    protocol: OPERATOR_EVENT_PROTOCOL,
    schema_version: 1,
    event_id: eventId,
    request_id: requestId,
    idempotency_key: idempotencyKey,
    kind,
    occurred_at: "2026-09-03T21:45:00+09:00",
    source: { type: "operator", adapter: "mission-guard-test", binding_id: BINDING },
    subject: { mission_id: missionId },
    intent: "TASK",
    requested_authority: authority,
    payload_ref: { sha256: PAYLOAD, location: `runtime-payload/${eventId}` },
    correlation_id: correlationId,
  };
}

function completion(summary = "done") {
  return {
    status: "COMPLETE",
    summary,
    changed_surface: [],
    evidence_refs: ["test:mission-store-recovery-guards"],
    remaining_limits: [],
    episode_aggregate: { episode_count: 0, runtime_classes: [], escalation_count: 0 },
  };
}

function createMission(store, suffix) {
  return store.submitOperatorEvent(operatorEvent({
    eventId: `evt-${suffix}`,
    requestId: `req-${suffix}`,
    idempotencyKey: `idem-${suffix}`,
    correlationId: `corr-${suffix}`,
  }));
}

function deferFollowup(store, missionId, suffix) {
  const event = operatorEvent({
    eventId: `evt-${suffix}-follow`,
    requestId: `req-${suffix}-follow`,
    idempotencyKey: `idem-${suffix}-follow`,
    kind: "operator.followup.submitted",
    missionId,
    authority: "READ_ONLY",
    correlationId: `corr-${suffix}-follow`,
  });
  const receipt = store.submitOperatorEvent(event);
  assert.equal(receipt.status, "DEFERRED");
  return event;
}

test("restart projects canonical APPLIED status after crash between Event journal and idempotency receipt refresh", () => {
  const root = tmp();
  const store = new DevExecMissionStore({ stateDir: root });
  const created = createMission(store, "projection-crash");
  const follow = deferFollowup(store, created.mission_id, "projection-crash");

  const originalRenameSync = fs.renameSync;
  let injected = false;
  fs.renameSync = function injectedRenameSync(source, destination, ...rest) {
    if (!injected && String(destination).includes(`${path.sep}idempotency${path.sep}`)) {
      injected = true;
      const error = new Error("injected idempotency projection crash");
      error.code = "EIO";
      throw error;
    }
    return originalRenameSync.call(fs, source, destination, ...rest);
  };
  try {
    assert.throws(
      () => store.applyDeferredEvent({
        mission_id: created.mission_id,
        event_id: follow.event_id,
        safe_boundary: "FRESH_NEXT_EPISODE",
      }),
      /injected idempotency projection crash/,
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.equal(injected, true);

  const reopened = new DevExecMissionStore({ stateDir: root });
  assert.equal(reopened.readEvent(follow.event_id).status, "APPLIED");
  const receiptProjection = reopened.listIdempotencyReceipts().find((item) => item.event_id === follow.event_id);
  assert.equal(receiptProjection.status, "APPLIED");
  assert.equal(receiptProjection.reason_code, null);

  const duplicate = reopened.submitOperatorEvent(follow);
  assert.equal(duplicate.status, "DUPLICATE");
  assert.equal(duplicate.canonical_status, "APPLIED");
  assert.deepEqual(reopened.readMission(created.mission_id).deferred_event_ids, []);
  assert.equal(reopened.readMission(created.mission_id).followups.length, 1);
});

test("MissionResult commit is blocked until every accepted follow-up leaves DEFERRED", () => {
  const root = tmp();
  const store = new DevExecMissionStore({ stateDir: root });
  const created = createMission(store, "terminal-guard");
  const follow = deferFollowup(store, created.mission_id, "terminal-guard");

  assert.throws(
    () => store.completeMission(created.mission_id, completion("must wait")),
    (error) => error instanceof MissionCoreError && error.code === "DEFERRED_EVENTS_PENDING",
  );
  assert.equal(store.readMissionResult(created.mission_id), null);

  store.applyDeferredEvent({
    mission_id: created.mission_id,
    event_id: follow.event_id,
    safe_boundary: "FRESH_NEXT_EPISODE",
  });
  const committed = store.completeMission(created.mission_id, completion("after apply"));
  assert.equal(committed.status, "COMMITTED");
  assert.equal(store.readMission(created.mission_id).status, "COMPLETE");
});

test("legacy terminal Mission with a still-deferred Event fails closed instead of applying after termination", () => {
  const root = tmp();
  const legacyCore = new CoreDevExecMissionStore({ stateDir: root });
  const created = createMission(legacyCore, "legacy-terminal");
  const follow = deferFollowup(legacyCore, created.mission_id, "legacy-terminal");
  legacyCore.completeMission(created.mission_id, completion("legacy terminal"));

  const guarded = new DevExecMissionStore({ stateDir: root });
  assert.equal(guarded.readMission(created.mission_id).status, "COMPLETE");
  assert.deepEqual(guarded.readMission(created.mission_id).deferred_event_ids, [follow.event_id]);
  assert.throws(
    () => guarded.applyDeferredEvent({
      mission_id: created.mission_id,
      event_id: follow.event_id,
      safe_boundary: "FRESH_NEXT_EPISODE",
    }),
    (error) => error instanceof MissionCoreError && error.code === "MISSION_TERMINAL",
  );
  assert.equal(guarded.readEvent(follow.event_id).status, "DEFERRED");
});
