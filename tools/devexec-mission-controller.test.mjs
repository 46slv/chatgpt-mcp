import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DevExecMissionController,
  MISSION_COMMAND_PROTOCOL,
  MISSION_REQUEST_PROTOCOL,
  MissionControllerError,
} from "./devexec-mission-controller.mjs";

const BINDING = `sha256:${"a".repeat(64)}`;
const CONTROLLER_URL = new URL("./devexec-mission-controller.mjs", import.meta.url).href;

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "devexec-f03-controller-"));
}

function authority({ requested_authority: requestedAuthority }) {
  return { allowed: new Set(["READ_ONLY", "BOUNDED_WRITE"]).has(requestedAuthority), authority_ref: "test:authority-fixture" };
}

function controller(root, options = {}) {
  return new DevExecMissionController({
    stateDir: root,
    validateAuthority: options.validateAuthority || authority,
    verifyFreshContext: options.verifyFreshContext || (({ episode }) => ({ verified: true, receipt_sha256: episode.parent_receipt_ref.sha256 })),
  });
}

function request({ suffix = "base", intent = "TASK", requestedAuthority = intent === "CONSULTATION" ? "READ_ONLY" : "BOUNDED_WRITE" } = {}) {
  return {
    protocol: MISSION_REQUEST_PROTOCOL,
    schema_version: 1,
    event_id: `evt-create-${suffix}`,
    request_id: `req-create-${suffix}`,
    idempotency_key: `idem-create-${suffix}`,
    occurred_at: "2026-09-08T00:00:00.000Z",
    source: { type: "operator", adapter: "f03-test", binding_id: BINDING },
    actor: { binding_id: BINDING, axis: "DETERMINISTIC", role: "OPERATOR_INGRESS" },
    intent,
    requested_authority: requestedAuthority,
    goal: {
      goal_id: `goal-${suffix}`,
      summary: "Complete the bounded fixture",
      acceptance_refs: ["test:f03"],
      protected_constraints: ["no-out-of-scope-write"],
    },
    correlation_id: `corr-create-${suffix}`,
  };
}

function actor(axis, role) {
  return {
    source: { type: "operator", adapter: "f03-test", binding_id: BINDING },
    actor: { binding_id: BINDING, axis, role },
  };
}

function command({ missionId, projection, suffix, action, data, axis = "MISSION_GOVERNANCE", role = "MISSION_GOVERNOR", occurredAt = null }) {
  return {
    protocol: MISSION_COMMAND_PROTOCOL,
    schema_version: 1,
    event_id: `evt-${suffix}`,
    request_id: `req-${suffix}`,
    idempotency_key: `idem-${suffix}`,
    occurred_at: occurredAt || `2026-09-08T00:${String(projection.revision).padStart(2, "0")}:00.000Z`,
    ...actor(axis, role),
    mission_id: missionId,
    expected_revision: projection.revision,
    action,
    data,
    correlation_id: `corr-${suffix}`,
  };
}

function startMission(control, missionId, suffix = "start") {
  const projection = control.inspect(missionId);
  return control.control(command({ missionId, projection, suffix, action: "START", data: { reason: "authorized start" } }));
}

function startEpisode(control, missionId, { episodeId, axis, role, executionAuthority = "BOUNDED_WRITE" }) {
  const projection = control.inspect(missionId);
  const inputRef = control.writeArtifact({ missionId, kind: "EPISODE_INPUT", content: { episode_id: episodeId, revision: projection.revision } });
  const receiptRef = control.writeArtifact({ missionId, kind: "FRESH_CONTEXT_RECEIPT", content: { episode_id: episodeId, parent_verified: true } });
  return control.control(command({
    missionId,
    projection,
    suffix: `start-${episodeId}`,
    action: "START_EPISODE",
    data: {
      episode_id: episodeId,
      axis,
      role,
      input_ref: inputRef,
      source_revision: projection.revision,
      source_snapshot_hash: projection.snapshot_hash,
      session_id: `session-${episodeId}`,
      context_fingerprint: `sha256:${crypto.createHash("sha256").update(`context-${episodeId}`).digest("hex")}`,
      parent_receipt_ref: receiptRef,
      history_forwarded: false,
      execution_authority: executionAuthority,
      runtime_class: "deterministic-fixture",
      model: { configured_model: null, selected_model: null, loaded_model: null },
    },
  }));
}

function completeEpisode(control, missionId, { episodeId, axis, role, status = "PASS" }) {
  const projection = control.inspect(missionId);
  const outputRef = control.writeArtifact({ missionId, kind: "EPISODE_OUTPUT", content: { episode_id: episodeId, status } });
  return control.control(command({
    missionId,
    projection,
    suffix: `complete-${episodeId}`,
    action: "COMPLETE_EPISODE",
    data: { episode_id: episodeId, status, output_ref: outputRef, evidence_refs: [`test:${episodeId}`], summary: `${episodeId} ${status}` },
    axis,
    role,
  }));
}

function runEpisode(control, missionId, input) {
  startEpisode(control, missionId, input);
  completeEpisode(control, missionId, input);
}

function repairFixture(suffix) {
  const root = tmp();
  const control = controller(root);
  const missionId = control.submit(request({ suffix })).mission_id;
  startMission(control, missionId);
  return { root, control, missionId };
}

function verifiedGoalCommand(control, missionId, suffix = "repair-goal") {
  return command({ missionId, projection: control.inspect(missionId), suffix, action: "ADVANCE_GOAL", axis: "GOAL_CONTROL", role: "GOAL_CONTROLLER", data: { decision: "COMPLETE", verification_episode_id: "verifier", evidence_refs: [], summary: "verified" } });
}

function terminalCommand(control, missionId, suffix = "repair-terminal", action = "COMPLETE") {
  return command({ missionId, projection: control.inspect(missionId), suffix, action, data: action === "CANCEL" ? { reason: "cancel fixture", evidence_refs: [] } : { summary: "complete fixture", changed_surface: [], evidence_refs: [], remaining_limits: [], verification_episode_id: "verifier" } });
}

const VERIFIER = { episodeId: "verifier", axis: "GOAL_CONTROL", role: "TECHNICAL_VERIFIER" };
const LATER_WORKER = { episodeId: "later-worker", axis: "TASK_EXECUTION", role: "WORKER", status: "FAIL" };

test("F03-V01: replay, Goal and terminal reads reject corrupt verifier artifacts", () => {
  const { root, control, missionId } = repairFixture("repair-corruption");
  runEpisode(control, missionId, VERIFIER);
  const advance = verifiedGoalCommand(control, missionId);
  const ref = control.inspect(missionId).episodes[0].output_ref;
  const file = path.join(root, ref.location);
  const bytes = fs.readFileSync(file);
  fs.writeFileSync(file, "CORRUPTED");
  assert.throws(() => controller(root).inspect(missionId), { code: "CORRUPT_MISSION_ARTIFACT" });
  assert.throws(() => control.control(advance), { code: "CORRUPT_MISSION_ARTIFACT" });
  fs.writeFileSync(file, bytes);
  control.control(advance);
  const finish = terminalCommand(control, missionId);
  control.control(finish);
  fs.writeFileSync(file, "CORRUPTED");
  assert.throws(() => controller(root).result(missionId), { code: "CORRUPT_MISSION_ARTIFACT" });
  assert.throws(() => control.control(finish), { code: "CORRUPT_MISSION_ARTIFACT" });
});

test("F03-V02: older PASS cannot verify later failed work or changed scope", () => {
  const { control, missionId } = repairFixture("repair-stale-verifier");
  runEpisode(control, missionId, VERIFIER);
  runEpisode(control, missionId, LATER_WORKER);
  assert.throws(() => control.control(verifiedGoalCommand(control, missionId)), { code: "STALE_VERIFICATION" });
  runEpisode(control, missionId, { ...VERIFIER, episodeId: "fresh-verifier" });
  const fresh = verifiedGoalCommand(control, missionId, "fresh-goal");
  fresh.data.verification_episode_id = "fresh-verifier";
  assert.equal(control.control(fresh).status, "APPLIED");
  const payloadRef = control.writeArtifact({ missionId, kind: "FOLLOWUP_INPUT", content: { change: "new scope" } });
  control.control(command({ missionId, projection: control.inspect(missionId), suffix: "new-scope", action: "FOLLOWUP", axis: "DETERMINISTIC", role: "OPERATOR_INGRESS", data: { payload_ref: payloadRef, summary: "scope changed" } }));
  const stale = verifiedGoalCommand(control, missionId, "scope-goal");
  stale.data.verification_episode_id = "fresh-verifier";
  assert.throws(() => control.control(stale), { code: "STALE_VERIFICATION" });
});

test("F03-V03: later work invalidates a completed Goal before worker completion", () => {
  const { control, missionId } = repairFixture("repair-invalidation");
  runEpisode(control, missionId, VERIFIER);
  control.control(verifiedGoalCommand(control, missionId));
  startEpisode(control, missionId, LATER_WORKER);
  assert.equal(control.inspect(missionId).goal.status, "OPEN");
  assert.equal(control.inspect(missionId).goal.last_verification_episode_id, null);
  completeEpisode(control, missionId, LATER_WORKER);
  assert.throws(() => control.control(terminalCommand(control, missionId)), { code: "GOAL_NOT_INDEPENDENTLY_COMPLETE" });
});

test("F03-V04: duplicate and explicit reconcile recover durable admission under the public lock", () => {
  for (const explicit of [false, true]) {
    const { root, control, missionId } = repairFixture(`repair-admission-${explicit}`);
    const pause = command({ missionId, projection: control.inspect(missionId), suffix: "crash-pause", action: "PAUSE", data: { reason: "pause" } });
    control.coreApply = () => { throw new Error("injected admission crash"); };
    assert.throws(() => control.control(pause), /injected admission crash/);
    const reopened = controller(root);
    if (explicit) assert.equal(reopened.reconcile(missionId).status, "PAUSED");
    const duplicate = reopened.control(pause);
    assert.equal(duplicate.canonical_status, "APPLIED");
    assert.equal(reopened.inspect(missionId).deferred_commands.length, 0);
    assert.equal(reopened.inspect(missionId).status, "PAUSED");
    assert.equal(reopened.control(terminalCommand(reopened, missionId, "cancel", "CANCEL")).mission_result.status, "CANCELLED");
  }
});

test("F03-V05: restart finalizes the exact terminal APPLIED command once", () => {
  for (const action of ["CANCEL", "COMPLETE"]) {
    const { root, control, missionId } = repairFixture(`repair-terminal-${action}`);
    if (action === "COMPLETE") {
      runEpisode(control, missionId, VERIFIER);
      control.control(verifiedGoalCommand(control, missionId));
    }
    const finish = terminalCommand(control, missionId, "crash-terminal", action);
    control.coreComplete = () => { throw new Error("injected terminal crash"); };
    assert.throws(() => control.control(finish), /injected terminal crash/);
    const reopened = controller(root);
    assert.equal(reopened.result(missionId).status, "RECONCILIATION_REQUIRED");
    const duplicate = reopened.control(finish);
    assert.equal(duplicate.canonical_status, "APPLIED");
    assert.equal(duplicate.mission_result.status, action === "CANCEL" ? "CANCELLED" : "COMPLETE");
    const resultId = duplicate.mission_result.result_id;
    reopened.reconcile(missionId);
    assert.equal(reopened.control(finish).mission_result.result_id, resultId);
  }
});

test("F03-V06: latest journal sequence delivers deferred updates with consistent pages", () => {
  const { control, missionId } = repairFixture("repair-cursor");
  startEpisode(control, missionId, LATER_WORKER);
  const pause = command({ missionId, projection: control.inspect(missionId), suffix: "cursor-pause", action: "PAUSE", data: { reason: "pause" } });
  control.control(pause);
  const first = control.listEvents(missionId);
  completeEpisode(control, missionId, LATER_WORKER);
  const later = control.listEvents(missionId, { after: first.next_cursor });
  assert.equal(later.events.find((event) => event.event_id === pause.event_id)?.status, "APPLIED");
  let cursor = first.next_cursor;
  const paged = [];
  for (;;) {
    const page = control.listEvents(missionId, { after: cursor, limit: 1 });
    if (!page.events.length) break;
    assert.ok(page.next_cursor > cursor);
    paged.push(...page.events);
    cursor = page.next_cursor;
  }
  assert.deepEqual(paged, later.events);
  assert.equal(cursor, later.next_cursor);
});

test("reconciliation revalidates authority and artifacts and holds one public lock", () => {
  const { root, control, missionId } = repairFixture("repair-reconcile-validation");
  startEpisode(control, missionId, LATER_WORKER);
  const cancel = terminalCommand(control, missionId, "pending-cancel", "CANCEL");
  assert.equal(control.control(cancel).status, "DEFERRED");
  control.coreApply = () => { throw new Error("injected outcome admission crash"); };
  assert.throws(() => completeEpisode(control, missionId, LATER_WORKER), /injected outcome admission crash/);
  const denied = controller(root, { validateAuthority: () => ({ allowed: false }) });
  assert.throws(() => denied.reconcile(missionId), { code: "AUTHORITY_DENIED" });
  assert.equal(denied.inspect(missionId).active_episode.episode_id, "later-worker");
  const reopened = controller(root);
  const outcomeEvent = reopened.store.readEvent("evt-complete-later-worker");
  const outcome = reopened.readPayload(outcomeEvent.event.payload_ref);
  const file = path.join(root, outcome.data.output_ref.location);
  const bytes = fs.readFileSync(file);
  fs.writeFileSync(file, "CORRUPTED");
  assert.throws(() => reopened.reconcile(missionId), { code: "CORRUPT_MISSION_ARTIFACT" });
  fs.writeFileSync(file, bytes);
  const withTransition = reopened.store.withMissionTransition.bind(reopened.store);
  const apply = reopened.coreApply.bind(reopened);
  const complete = reopened.coreComplete.bind(reopened);
  let locked = false;
  let lockCount = 0;
  reopened.store.withMissionTransition = (id, operation) => withTransition(id, () => {
    assert.equal(locked, false);
    locked = true;
    lockCount += 1;
    try { return operation(); } finally { locked = false; }
  });
  reopened.coreApply = (input) => { assert.equal(locked, true); return apply(input); };
  reopened.coreComplete = (id, input) => { assert.equal(locked, true); return complete(id, input); };
  assert.equal(reopened.reconcile(missionId).result_status, "CANCELLED");
  assert.equal(lockCount, 1);
  assert.equal(reopened.inspect(missionId).deferred_commands.length, 0);
});

test("ten fresh Episodes preserve three axes and gate Goal/Mission completion on independent verification", () => {
  const root = tmp();
  const control = controller(root);
  const created = control.submit(request({ suffix: "ten" }));
  const missionId = created.mission_id;
  assert.equal(control.inspect(missionId).status, "CREATED");
  startMission(control, missionId);

  for (let index = 1; index <= 9; index += 1) {
    runEpisode(control, missionId, { episodeId: `worker-${index}`, axis: "TASK_EXECUTION", role: "WORKER" });
  }
  runEpisode(control, missionId, { episodeId: "verifier-10", axis: "GOAL_CONTROL", role: "TECHNICAL_VERIFIER" });

  let projection = control.inspect(missionId);
  assert.equal(projection.episodes.length, 10);
  assert.equal(new Set(projection.episodes.map((item) => item.session_id)).size, 10);
  assert.equal(new Set(projection.episodes.map((item) => item.context_fingerprint)).size, 10);
  assert.equal(projection.episodes.every((item) => item.history_forwarded === false && item.freshness === "PARENT_VERIFIED"), true);
  assert.equal(projection.active_episode, null);

  const advance = command({
    missionId,
    projection,
    suffix: "goal-complete",
    action: "ADVANCE_GOAL",
    data: { decision: "COMPLETE", verification_episode_id: "verifier-10", evidence_refs: ["test:verifier-10"], summary: "independently verified" },
    axis: "GOAL_CONTROL",
    role: "GOAL_CONTROLLER",
  });
  assert.equal(control.control(advance).status, "APPLIED");
  projection = control.inspect(missionId);
  assert.equal(projection.goal.status, "COMPLETE");

  const finish = command({
    missionId,
    projection,
    suffix: "mission-complete",
    action: "COMPLETE",
    data: {
      summary: "fixture complete",
      changed_surface: ["fixture/output"],
      evidence_refs: ["test:verifier-10"],
      remaining_limits: [],
      verification_episode_id: "verifier-10",
    },
  });
  const completed = control.control(finish);
  assert.equal(completed.status, "APPLIED");
  assert.equal(completed.mission_result.status, "COMPLETE");
  assert.equal(completed.mission_result.episode_aggregate.episode_count, 10);
  assert.equal(control.inspect(missionId).status, "COMPLETE");

  const duplicate = control.control(finish);
  assert.equal(duplicate.status, "DUPLICATE");
  assert.equal(duplicate.canonical_status, "APPLIED");
  assert.equal(duplicate.mission_result.result_id, completed.mission_result.result_id);
  assert.equal(control.store.listEvents({ missionId }).length, 1 + 1 + 10 * 2 + 2);
});

test("pause waits for the active Episode boundary, survives restart, and resume creates no fake active state", () => {
  const root = tmp();
  let control = controller(root);
  const missionId = control.submit(request({ suffix: "pause" })).mission_id;
  startMission(control, missionId);
  startEpisode(control, missionId, { episodeId: "worker-pause", axis: "TASK_EXECUTION", role: "WORKER" });
  let projection = control.inspect(missionId);
  const pause = command({ missionId, projection, suffix: "pause-request", action: "PAUSE", data: { reason: "safe boundary" } });
  const deferred = control.control(pause);
  assert.equal(deferred.status, "DEFERRED");
  assert.equal(control.inspect(missionId).status, "RUNNING");
  assert.equal(control.inspect(missionId).deferred_commands[0].action, "PAUSE");

  control = controller(root);
  completeEpisode(control, missionId, { episodeId: "worker-pause", axis: "TASK_EXECUTION", role: "WORKER" });
  projection = control.inspect(missionId);
  assert.equal(projection.status, "PAUSED");
  assert.equal(projection.active_episode, null);
  assert.deepEqual(projection.deferred_commands, []);

  const resumed = control.control(command({ missionId, projection, suffix: "resume", action: "RESUME", data: { reason: "continue" } }));
  assert.equal(resumed.mission_status, "RUNNING");
  assert.equal(control.inspect(missionId).active_episode, null);
});

test("operator follow-up preserves active Episode input and applies only at its fresh boundary", () => {
  const root = tmp();
  let control = controller(root);
  const missionId = control.submit(request({ suffix: "followup" })).mission_id;
  startMission(control, missionId);
  startEpisode(control, missionId, { episodeId: "worker-before-followup", axis: "TASK_EXECUTION", role: "WORKER" });
  const before = control.inspect(missionId);
  const frozenInput = before.active_episode.input_ref.sha256;
  const followupRef = control.writeArtifact({ missionId, kind: "FOLLOWUP_INPUT", content: { operator_fact: "new bounded fact" } });
  const followup = command({
    missionId,
    projection: before,
    suffix: "operator-followup",
    action: "FOLLOWUP",
    data: { payload_ref: followupRef, summary: "new bounded fact" },
    axis: "DETERMINISTIC",
    role: "OPERATOR_INGRESS",
  });
  assert.equal(control.control(followup).status, "DEFERRED");
  const during = control.inspect(missionId);
  assert.equal(during.active_episode.input_ref.sha256, frozenInput);
  assert.deepEqual(during.context_events, []);

  control = controller(root);
  completeEpisode(control, missionId, { episodeId: "worker-before-followup", axis: "TASK_EXECUTION", role: "WORKER" });
  const after = control.inspect(missionId);
  assert.equal(after.active_episode, null);
  assert.equal(after.context_events.length, 1);
  assert.equal(after.context_events[0].payload_ref.sha256, followupRef.sha256);
  assert.deepEqual(after.deferred_commands, []);
});

test("cancel requested during execution commits one canonical CANCELLED result at the Episode boundary", () => {
  const root = tmp();
  const control = controller(root);
  const missionId = control.submit(request({ suffix: "cancel" })).mission_id;
  startMission(control, missionId);
  startEpisode(control, missionId, { episodeId: "worker-cancel", axis: "TASK_EXECUTION", role: "WORKER" });
  const running = control.inspect(missionId);
  const cancel = command({
    missionId,
    projection: running,
    suffix: "cancel-request",
    action: "CANCEL",
    data: { reason: "operator cancellation", evidence_refs: ["test:cancel-request"] },
  });
  assert.equal(control.control(cancel).status, "DEFERRED");
  completeEpisode(control, missionId, { episodeId: "worker-cancel", axis: "TASK_EXECUTION", role: "WORKER", status: "CANCELLED" });
  const projection = control.inspect(missionId);
  const result = control.result(missionId);
  assert.equal(projection.status, "CANCELLED");
  assert.equal(result.status, "CANCELLED");
  assert.equal(result.episode_aggregate.episode_count, 1);
  assert.equal(control.control(cancel).mission_result.result_id, result.result_id);
});

test("CONSULTATION execution cannot exceed READ_ONLY and role/Goal boundaries fail closed", () => {
  const root = tmp();
  const control = controller(root);
  const missionId = control.submit(request({ suffix: "consult", intent: "CONSULTATION" })).mission_id;
  startMission(control, missionId);
  assert.throws(
    () => startEpisode(control, missionId, { episodeId: "consult-write", axis: "TASK_EXECUTION", role: "WORKER", executionAuthority: "BOUNDED_WRITE" }),
    (error) => error instanceof MissionControllerError && error.code === "EPISODE_AUTHORITY_EXCEEDED",
  );

  let projection = control.inspect(missionId);
  assert.throws(
    () => control.control(command({ missionId, projection, suffix: "worker-pause-invalid", action: "PAUSE", data: { reason: "peer control" }, axis: "TASK_EXECUTION", role: "WORKER" })),
    (error) => error instanceof MissionControllerError && error.code === "MISSION_GOVERNANCE_REQUIRED",
  );
  assert.throws(
    () => control.control(command({ missionId, projection, suffix: "goal-self-certify", action: "ADVANCE_GOAL", data: { decision: "COMPLETE", verification_episode_id: "missing", evidence_refs: [], summary: "self claim" }, axis: "GOAL_CONTROL", role: "GOAL_CONTROLLER" })),
    (error) => error instanceof MissionControllerError && error.code === "INDEPENDENT_VERIFICATION_REQUIRED",
  );
  assert.equal(control.inspect(missionId).revision, projection.revision);
});

test("stale revision, artifact cross-scope, and corrupt content-addressed payload are rejected", () => {
  const root = tmp();
  const control = controller(root);
  const missionA = control.submit(request({ suffix: "corrupt-a" })).mission_id;
  const missionB = control.submit(request({ suffix: "corrupt-b" })).mission_id;
  const stale = control.inspect(missionA);
  startMission(control, missionA);
  assert.throws(
    () => control.control(command({ missionId: missionA, projection: stale, suffix: "stale", action: "PAUSE", data: { reason: "stale" } })),
    (error) => error instanceof MissionControllerError && error.code === "STALE_MISSION_OBSERVATION",
  );

  const projection = control.inspect(missionA);
  const foreign = control.writeArtifact({ missionId: missionB, kind: "EPISODE_INPUT", content: { foreign: true } });
  const receipt = control.writeArtifact({ missionId: missionA, kind: "FRESH_CONTEXT_RECEIPT", content: { valid: true } });
  const badStart = command({
    missionId: missionA,
    projection,
    suffix: "cross-scope",
    action: "START_EPISODE",
    data: {
      episode_id: "cross-scope",
      axis: "TASK_EXECUTION",
      role: "WORKER",
      input_ref: foreign,
      source_revision: projection.revision,
      source_snapshot_hash: projection.snapshot_hash,
      session_id: "session-cross-scope",
      context_fingerprint: `sha256:${"b".repeat(64)}`,
      parent_receipt_ref: receipt,
      history_forwarded: false,
      execution_authority: "BOUNDED_WRITE",
      runtime_class: "fixture",
      model: { configured_model: null, selected_model: null, loaded_model: null },
    },
  });
  assert.throws(() => control.control(badStart), (error) => error instanceof MissionControllerError && error.code === "ARTIFACT_SCOPE_MISMATCH");

  const startEvent = control.store.readEvent("evt-start");
  const payloadPath = path.join(root, ...startEvent.event.payload_ref.location.split("/"));
  fs.writeFileSync(payloadPath, "{}\n", "utf8");
  assert.throws(() => control.inspect(missionA), (error) => error instanceof MissionControllerError && error.code === "CORRUPT_MISSION_PROJECTION");
});

function childControl(root, commandInput) {
  const source = `
    const { DevExecMissionController } = await import(process.env.CONTROLLER_URL);
    const controller = new DevExecMissionController({
      stateDir: process.env.ROOT,
      validateAuthority: () => ({ allowed: true, authority_ref: "test:child" }),
    });
    try {
      const value = controller.control(JSON.parse(process.env.COMMAND));
      process.stdout.write(JSON.stringify({ ok: true, value }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, code: error.code || null, message: error.message }));
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      env: { ...process.env, CONTROLLER_URL, ROOT: root, COMMAND: JSON.stringify(commandInput) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(`child ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
  });
}

test("concurrent identical START controls serialize to one applied Event and one duplicate receipt", async () => {
  const root = tmp();
  const control = controller(root);
  const missionId = control.submit(request({ suffix: "race" })).mission_id;
  const projection = control.inspect(missionId);
  const start = command({ missionId, projection, suffix: "race-start", action: "START", data: { reason: "race" } });
  const outcomes = await Promise.all(Array.from({ length: 8 }, () => childControl(root, start)));
  const success = outcomes.filter((item) => item.ok).map((item) => item.value.status);
  assert.equal(success.includes("APPLIED"), true, JSON.stringify(outcomes));
  assert.equal(success.every((status) => new Set(["APPLIED", "DUPLICATE"]).has(status)), true, JSON.stringify(outcomes));
  const reopened = controller(root);
  assert.equal(reopened.inspect(missionId).status, "RUNNING");
  assert.equal(reopened.inspect(missionId).revision, 2);
  assert.equal(reopened.store.listEvents({ missionId }).filter((event) => event.event_id === start.event_id).length, 1);
  assert.equal(reopened.store.verifyDurableState().valid, true);
});

test("authority validation is mandatory and denial occurs before Event/payload side effects", () => {
  const root = tmp();
  const missing = new DevExecMissionController({ stateDir: root });
  assert.throws(() => missing.submit(request({ suffix: "missing-authority" })), (error) => error.code === "AUTHORITY_VALIDATOR_REQUIRED");
  assert.equal(missing.store.readJournal().length, 0);
  assert.equal(fs.readdirSync(path.join(root, "mission-control", "payloads")).length, 0);

  const denied = controller(root, { validateAuthority: () => ({ allowed: false, authority_ref: "test:denied" }) });
  assert.throws(() => denied.submit(request({ suffix: "denied" })), (error) => error.code === "AUTHORITY_DENIED");
  assert.equal(denied.store.readJournal().length, 0);
});
