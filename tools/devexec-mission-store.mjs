export * from "./devexec-mission-store-core.mjs";

import {
  DevExecMissionStore as CoreDevExecMissionStore,
  MissionCoreError,
} from "./devexec-mission-store-core.mjs";
import {
  MissionTransitionLockError,
  withMissionTransitionLock,
} from "./devexec-mission-transition-lock.mjs";

function reconcileReceiptFromJournal(store, receipt) {
  if (!receipt?.event_id || receipt.status !== "DUPLICATE") return receipt;
  const event = store.readEvent(receipt.event_id);
  if (!event) throw new MissionCoreError("CORRUPT_IDEMPOTENCY_STATE", "duplicate receipt has no canonical Event");
  if (event.mission_id !== receipt.mission_id || event.idempotency_digest !== receipt.idempotency_digest) {
    throw new MissionCoreError("CORRUPT_IDEMPOTENCY_STATE", "duplicate receipt identity does not match canonical Event");
  }
  return {
    ...receipt,
    canonical_status: event.status,
    journal_seq: event.journal_seq,
  };
}

/**
 * Public Mission/Event substrate surface.
 *
 * The preserved core owns durable journal/snapshot/result mechanics. This
 * facade adds cross-operation fail-closed guards that depend on more than one
 * durable projection. The Event journal remains canonical when a crash lands
 * after an APPLIED record but before its idempotency receipt projection is
 * refreshed.
 *
 * Mission-scoped mutations that can change terminal/deferred state are
 * serialized cross-process. A crashed owner leaves inspectable lock evidence
 * and is never auto-broken; the next mutation fails closed instead of guessing
 * whether the prior commit completed.
 */
export class DevExecMissionStore extends CoreDevExecMissionStore {
  constructor(options = {}) {
    super(options);
    this.transitionLockTimeoutMs = options.transitionLockTimeoutMs ?? 30_000;
    this.transitionLockPollMs = options.transitionLockPollMs ?? 10;
  }

  withMissionTransition(missionId, operation) {
    try {
      return withMissionTransitionLock({
        stateDir: this.stateDir,
        missionId,
        timeoutMs: this.transitionLockTimeoutMs,
        pollMs: this.transitionLockPollMs,
      }, operation);
    } catch (error) {
      if (error instanceof MissionTransitionLockError) {
        throw new MissionCoreError(error.code, error.message);
      }
      throw error;
    }
  }

  duplicateOrConflict(event, digest, eventDigest, existing) {
    return reconcileReceiptFromJournal(
      this,
      super.duplicateOrConflict(event, digest, eventDigest, existing),
    );
  }

  listIdempotencyReceipts() {
    const receipts = super.listIdempotencyReceipts();
    const events = new Map(super.listEvents().map((event) => [event.event_id, event]));
    return receipts.map((receipt) => {
      const event = events.get(receipt.event_id);
      if (!event || event.mission_id !== receipt.mission_id || event.idempotency_digest !== receipt.idempotency_digest) {
        throw new MissionCoreError("CORRUPT_IDEMPOTENCY_STATE", "idempotency receipt does not match canonical Event");
      }
      return {
        ...receipt,
        status: event.status,
        reason_code: event.reason_code,
        journal_seq: event.journal_seq,
      };
    });
  }

  submitOperatorEvent(input) {
    const missionId = input?.kind === "operator.followup.submitted" ? input?.subject?.mission_id : null;
    if (typeof missionId !== "string" || !missionId) return super.submitOperatorEvent(input);
    return this.withMissionTransition(missionId, () => super.submitOperatorEvent(input));
  }

  applyDeferredEvent(input = {}) {
    const missionId = input?.mission_id;
    const operation = () => {
      const eventId = input?.event_id;
      const event = eventId ? this.readEvent(eventId) : null;
      if (event?.status === "APPLIED") return super.applyDeferredEvent(input);
      const mission = missionId ? this.readMission(missionId) : null;
      if (!mission) throw new MissionCoreError("MISSION_NOT_FOUND", "Mission not found");
      if (mission.status !== "OPEN") {
        throw new MissionCoreError("MISSION_TERMINAL", "deferred Event cannot be applied after Mission termination");
      }
      return super.applyDeferredEvent(input);
    };
    if (typeof missionId !== "string" || !missionId) return operation();
    return this.withMissionTransition(missionId, operation);
  }

  completeMission(missionId, completionInput) {
    return this.withMissionTransition(missionId, () => {
      const mission = this.readMission(missionId);
      if (!mission) throw new MissionCoreError("MISSION_NOT_FOUND", "Mission not found");
      if (mission.deferred_event_ids.length > 0) {
        throw new MissionCoreError(
          "DEFERRED_EVENTS_PENDING",
          "MissionResult cannot be committed while accepted follow-up Events remain deferred",
        );
      }
      return super.completeMission(missionId, completionInput);
    });
  }
}

export function createDevExecMissionStore(options) {
  return new DevExecMissionStore(options);
}
