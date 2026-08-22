import crypto from "node:crypto";

import {
  beginMissionAmendmentApply,
  completeMissionAmendmentApply,
  listApplicableMissionAmendments,
} from "./devexec-mission-control.mjs";
import {
  applyMissionObjectiveAmendment,
  normalizeMissionObjectivePayload,
} from "./devexec-mission-objective.mjs";

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} required`);
  return value.trim();
}

function supported(amendment) {
  try {
    normalizeMissionObjectivePayload(amendment);
    return true;
  } catch (error) {
    if (/MISSION_OBJECTIVE_(UNSUPPORTED|UNKNOWN|EMPTY|PAYLOAD)/.test(String(error?.message || error))) return false;
    throw error;
  }
}

export function applyOneMissionObjectiveAmendment(control, amendment, boundary, {
  base,
  apply_attempt_id = crypto.randomUUID(),
  now = new Date().toISOString(),
} = {}) {
  if (!control?.state?.mission_id) throw new Error("mission control required");
  const attemptId = required(apply_attempt_id, "apply_attempt_id");
  normalizeMissionObjectivePayload(amendment);

  const begun = beginMissionAmendmentApply(control, amendment.amendment_id, boundary, {
    apply_attempt_id: attemptId,
    now,
  });
  const mutation = applyMissionObjectiveAmendment({
    base,
    mission_id: control.state.mission_id,
    amendment: begun.amendment,
    apply_attempt_id: attemptId,
    now,
  });
  const completed = completeMissionAmendmentApply(control, amendment.amendment_id, {
    apply_attempt_id: attemptId,
    now,
  });
  return {amendment: completed.amendment, mutation, apply_attempt_id: attemptId};
}

export function reconcileApplyingMissionObjectiveAmendments(control, {
  base,
  now = new Date().toISOString(),
} = {}) {
  if (!control?.state?.mission_id || !control?.amendments?.amendments) throw new Error("mission control required");
  const reconciled = [];
  const blocked = [];
  for (const amendment of control.amendments.amendments.filter(item => item.status === "APPLYING")) {
    if (!supported(amendment)) {
      blocked.push({amendment_id: amendment.amendment_id, reason: "UNSUPPORTED_MUTATION_TARGET"});
      continue;
    }
    const attemptId = required(amendment.apply_attempt_id, "apply_attempt_id");
    const mutation = applyMissionObjectiveAmendment({
      base,
      mission_id: control.state.mission_id,
      amendment,
      apply_attempt_id: attemptId,
      now,
    });
    const completed = completeMissionAmendmentApply(control, amendment.amendment_id, {
      apply_attempt_id: attemptId,
      now,
    });
    reconciled.push({amendment: completed.amendment, mutation, apply_attempt_id: attemptId});
  }
  return {reconciled, blocked};
}

export function applyApplicableMissionObjectiveAmendments(control, boundary, {
  base,
  now = new Date().toISOString(),
  attempt_id_factory = amendment => `APPLY-${amendment.amendment_id}-${crypto.randomUUID()}`,
} = {}) {
  if (typeof attempt_id_factory !== "function") throw new Error("attempt_id_factory required");
  const recovery = reconcileApplyingMissionObjectiveAmendments(control, {base, now});
  const applied = [...recovery.reconciled];
  const skipped = [...recovery.blocked];

  for (const amendment of listApplicableMissionAmendments(control, boundary)) {
    if (!supported(amendment)) {
      skipped.push({amendment_id: amendment.amendment_id, reason: "UNSUPPORTED_MUTATION_TARGET"});
      continue;
    }
    applied.push(applyOneMissionObjectiveAmendment(control, amendment, boundary, {
      base,
      apply_attempt_id: required(attempt_id_factory(amendment), "apply_attempt_id"),
      now,
    }));
  }
  return {applied, skipped};
}
