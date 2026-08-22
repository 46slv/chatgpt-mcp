import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  carryAmendmentsToRun,
  createAmendmentQueue,
  enqueueAmendment,
  loadAmendmentQueue,
  setAmendmentDisposition,
} from "./devexec-mission-amendments.mjs";
import {
  beginMissionAmendmentApply,
  enqueueMissionAmendment,
  openMissionControl,
} from "./devexec-mission-control.mjs";
import {
  beginMissionChildLaunch,
  completeMissionChildLaunch,
  readMissionLaunchState,
  reconcileMissionChildLaunches,
  requestMissionChildLaunch,
} from "./devexec-mission-launch.mjs";
import {dispatchMissionChildLaunch} from "./devexec-mission-launcher.mjs";

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

function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-runtime-review-"));
  return Promise.resolve(fn(root)).finally(() => fs.rmSync(root, {recursive: true, force: true}));
}

test("same amendment delivery remains idempotent after child-run carry", () => {
  const queue = createAmendmentQueue({mission_id: "MISSION-001", run_id: "RUN-001"});
  enqueueAmendment(queue, amendment());
  carryAmendmentsToRun(queue, "RUN-002");

  const redelivery = enqueueAmendment(queue, amendment({amendment_id: "AMD-REDELIVERED"}));
  assert.equal(redelivery.deduplicated, true);
  assert.equal(redelivery.amendment.amendment_id, "AMD-001");
  assert.equal(redelivery.amendment.created_for_run_id, "RUN-001");
  assert.equal(queue.amendments.length, 1);
});

test("manual APPLIED disposition cannot bypass two-phase amendment apply", () => {
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

test("stale amendment control cannot erase an APPLYING fence while enqueueing new work", () => withRoot(root => {
  const seed = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  enqueueMissionAmendment(seed, amendment());

  const applyControl = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  const ingressControl = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});

  beginMissionAmendmentApply(applyControl, "AMD-001", {safe: true}, {apply_attempt_id: "APPLY-001"});
  enqueueMissionAmendment(ingressControl, amendment({
    amendment_id: "AMD-002",
    idempotency_key: "MISSION-001:operator:002",
    payload: {add_work: "B"},
  }));

  const disk = loadAmendmentQueue(seed.paths.amendments_file);
  assert.equal(disk.amendments.find(item => item.amendment_id === "AMD-001").status, "APPLYING");
  assert.equal(disk.amendments.find(item => item.amendment_id === "AMD-001").apply_attempt_id, "APPLY-001");
  assert.deepEqual(disk.amendments.map(item => item.amendment_id), ["AMD-001", "AMD-002"]);
}));

test("restarted dispatcher never respawns an already durable LAUNCHING attempt", () => withRoot(async root => {
  const control = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  const launch = requestMissionChildLaunch(control, {
    launch_id: "LAUNCH-001",
    idempotency_key: "MISSION-001:launch:001",
    child_run_id: "RUN-002",
    goal: "continue mission",
  }, {boundary: {safe: true}}).launch;

  beginMissionChildLaunch(control, launch.launch_id, {
    launch_attempt_id: "ATTEMPT-001",
    launcher_request_id: "REQ-001",
    lease_token: "LEASE-001",
  });

  let spawnCount = 0;
  await assert.rejects(
    dispatchMissionChildLaunch(control, launch, {
      launch_attempt_id: "ATTEMPT-001",
      launcher_request_id: "REQ-001",
      entry_path: "C:/repo/tools/devexec-goal.mjs",
      spawn_impl: () => {
        spawnCount += 1;
        throw new Error("must not spawn");
      },
    }),
    /MISSION_LAUNCH_DISPATCH_ALREADY_IN_FLIGHT/,
  );

  assert.equal(spawnCount, 0);
  const disk = readMissionLaunchState(control).launches[0];
  assert.equal(disk.status, "LAUNCHING");
  assert.equal(disk.launch_attempt_id, "ATTEMPT-001");
  assert.equal(disk.launcher_request_id, "REQ-001");
}));

test("two stale launch controls cannot both create active child intents", () => withRoot(root => {
  const firstControl = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  const secondControl = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});

  requestMissionChildLaunch(firstControl, {
    launch_id: "LAUNCH-001",
    idempotency_key: "launch-001",
    child_run_id: "RUN-002",
    goal: "first child",
  }, {boundary: {safe: true}});

  assert.throws(
    () => requestMissionChildLaunch(secondControl, {
      launch_id: "LAUNCH-002",
      idempotency_key: "launch-002",
      child_run_id: "RUN-003",
      goal: "second child",
    }, {boundary: {safe: true}}),
    /MISSION_LAUNCH_ACTIVE/,
  );
  assert.equal(readMissionLaunchState(firstControl).launches.length, 1);
}));

test("launch receipt can complete after child attaches and delayed reconciliation follows lineage", () => withRoot(root => {
  const parent = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  const launch = requestMissionChildLaunch(parent, {
    launch_id: "LAUNCH-001",
    idempotency_key: "launch-001",
    child_run_id: "RUN-002",
    goal: "child",
  }, {boundary: {safe: true}}).launch;
  beginMissionChildLaunch(parent, launch.launch_id, {
    launch_attempt_id: "ATTEMPT-001",
    launcher_request_id: "REQ-001",
    lease_token: "LEASE-001",
  });

  const child = openMissionControl({
    base: root,
    mission_id: "MISSION-001",
    run_id: "RUN-002",
    parent_run_id: "RUN-001",
  });
  completeMissionChildLaunch(parent, launch.launch_id, {
    launch_attempt_id: "ATTEMPT-001",
    receipt: {pid: 4242},
  });

  const grandchild = openMissionControl({
    base: root,
    mission_id: "MISSION-001",
    run_id: "RUN-003",
    parent_run_id: "RUN-002",
  });
  assert.equal(child.state.current_run_id, "RUN-002");
  assert.equal(reconcileMissionChildLaunches(grandchild).changed, true);
  assert.equal(readMissionLaunchState(grandchild).launches[0].status, "CONFIRMED");
}));
