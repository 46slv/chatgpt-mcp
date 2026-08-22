import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {withMissionLock} from "./devexec-mission-lock.mjs";
import {resolveMissionPaths} from "./devexec-mission-state.mjs";

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} required`);
  return value.trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}

function sha256Json(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function objectiveFile(paths) {
  return path.join(paths.root, "mission-objective.json");
}

function createObjectiveState(missionId) {
  return {
    protocol: "devexec.mission-objective",
    schema_version: 1,
    mission_id: missionId,
    revision: 0,
    queued_work: [],
    constraints: [],
    receipts: [],
  };
}

function loadObjectiveState(file, missionId) {
  if (!fs.existsSync(file)) return createObjectiveState(missionId);
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  if (state?.protocol !== "devexec.mission-objective" || state.schema_version !== 1) {
    throw new Error("invalid mission objective state");
  }
  if (state.mission_id !== missionId) throw new Error("MISSION_OBJECTIVE_ID_MISMATCH");
  if (!Array.isArray(state.queued_work) || !Array.isArray(state.constraints) || !Array.isArray(state.receipts)) {
    throw new Error("invalid mission objective collections");
  }
  return state;
}

function saveObjectiveState(file, state) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", "utf8");
  fs.renameSync(temp, file);
}

function asTextArray(value, name) {
  if (value == null) return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.length < 1) throw new Error(`${name} must not be empty`);
  return values.map((item, index) => required(item, `${name}[${index}]`));
}

export function normalizeMissionObjectivePayload(amendment) {
  if (!amendment || amendment.kind !== "MISSION_AMENDMENT") {
    throw new Error("MISSION_OBJECTIVE_UNSUPPORTED_AMENDMENT_KIND");
  }
  if (!["next_safe_boundary", "after_current_goal"].includes(amendment.apply_mode)) {
    throw new Error("MISSION_OBJECTIVE_UNSUPPORTED_APPLY_MODE");
  }
  const payload = amendment.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("MISSION_OBJECTIVE_PAYLOAD_OBJECT_REQUIRED");
  }
  const allowed = new Set(["add_work", "constraint", "constraints"]);
  const unknown = Object.keys(payload).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`MISSION_OBJECTIVE_UNKNOWN_PAYLOAD_KEYS:${unknown.sort().join(",")}`);

  const queuedWork = asTextArray(payload.add_work, "add_work");
  const constraints = [
    ...asTextArray(payload.constraint, "constraint"),
    ...asTextArray(payload.constraints, "constraints"),
  ];
  if (constraints.length > 0) {
    throw new Error("MISSION_OBJECTIVE_UNSUPPORTED_CONSTRAINT_ENFORCEMENT");
  }
  if (queuedWork.length < 1) {
    throw new Error("MISSION_OBJECTIVE_EMPTY_MUTATION");
  }
  return {queued_work: queuedWork, constraints: []};
}

export function applyMissionObjectiveAmendment({
  base,
  mission_id,
  amendment,
  apply_attempt_id,
  now = new Date().toISOString(),
} = {}) {
  const missionId = required(mission_id, "mission_id");
  const amendmentId = required(amendment?.amendment_id, "amendment_id");
  const attemptId = required(apply_attempt_id, "apply_attempt_id");
  const mutation = normalizeMissionObjectivePayload(amendment);
  const payloadHash = sha256Json({
    amendment_id: amendmentId,
    kind: amendment.kind,
    apply_mode: amendment.apply_mode,
    payload: amendment.payload,
  });
  const paths = resolveMissionPaths(base, missionId);
  const file = objectiveFile(paths);

  return withMissionLock(paths.root, () => {
    const state = loadObjectiveState(file, missionId);
    const existing = state.receipts.find(receipt => receipt.amendment_id === amendmentId);
    if (existing) {
      if (existing.apply_attempt_id !== attemptId) throw new Error("MISSION_OBJECTIVE_AMENDMENT_ATTEMPT_CONFLICT");
      if (existing.payload_sha256 !== payloadHash) throw new Error("MISSION_OBJECTIVE_AMENDMENT_PAYLOAD_CONFLICT");
      return {state, receipt: clone(existing), deduplicated: true, file};
    }

    for (const text of mutation.queued_work) {
      state.queued_work.push({
        text,
        amendment_id: amendmentId,
        apply_attempt_id: attemptId,
        queued_at: now,
      });
    }
    for (const text of mutation.constraints) {
      state.constraints.push({
        text,
        amendment_id: amendmentId,
        apply_attempt_id: attemptId,
        added_at: now,
      });
    }
    const receipt = {
      amendment_id: amendmentId,
      apply_attempt_id: attemptId,
      payload_sha256: payloadHash,
      queued_work_count: mutation.queued_work.length,
      constraint_count: mutation.constraints.length,
      applied_at: now,
    };
    state.receipts.push(receipt);
    state.revision += 1;
    saveObjectiveState(file, state);
    return {state, receipt: clone(receipt), deduplicated: false, file};
  });
}

export function readMissionObjective({base, mission_id} = {}) {
  const missionId = required(mission_id, "mission_id");
  const paths = resolveMissionPaths(base, missionId);
  const file = objectiveFile(paths);
  return withMissionLock(paths.root, () => clone(loadObjectiveState(file, missionId)));
}
