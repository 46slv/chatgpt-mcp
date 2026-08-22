import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {enqueueMissionAmendmentRequest, parseMissionAmendArgs} from "./devexec-mission-amend.mjs";
import {openMissionControl} from "./devexec-mission-control.mjs";
import {resolveMissionEntryIdentity} from "./devexec-mission-entry.mjs";
import {
  beginMissionChildLaunch,
  completeMissionChildLaunch,
  readMissionLaunchState,
  reconcileMissionChildLaunches,
  requestMissionChildLaunch,
} from "./devexec-mission-launch.mjs";
import {dispatchMissionChildLaunch} from "./devexec-mission-launcher.mjs";

function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-runtime-wiring-"));
  return Promise.resolve(fn(root)).finally(() => fs.rmSync(root, {recursive: true, force: true}));
}

function launchRequest(control, overrides = {}) {
  return requestMissionChildLaunch(control, {
    launch_id: overrides.launch_id ?? "LAUNCH-001",
    idempotency_key: overrides.idempotency_key ?? "MISSION-001:launch:001",
    child_run_id: overrides.child_run_id ?? "RUN-002",
    parent_run_id: overrides.parent_run_id,
    goal: overrides.goal ?? "continue mission",
    target_alias: overrides.target_alias,
  }, {boundary: overrides.boundary ?? {safe: true}});
}

test("root and child entry identities preserve one Mission", () => {
  assert.deepEqual(resolveMissionEntryIdentity({run_id: "RUN-001"}), {
    mission_id: "RUN-001", run_id: "RUN-001", parent_run_id: null,
  });
  assert.throws(
    () => resolveMissionEntryIdentity({run_id: "RUN-002", parent_run_id: "RUN-001"}),
    /DEV_EXEC_MISSION_ID_REQUIRED_FOR_CHILD/,
  );
  assert.equal(resolveMissionEntryIdentity({
    run_id: "RUN-002", parent_run_id: "RUN-001", mission_id: "MISSION-001",
  }).mission_id, "MISSION-001");
});

test("typed amendment ingress targets the current run and deduplicates", () => withRoot(root => {
  openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  const input = {
    base: root,
    mission_id: "MISSION-001",
    amendment_id: "AMD-001",
    idempotency_key: "operator-001",
    kind: "MISSION_AMENDMENT",
    apply_mode: "next_safe_boundary",
    priority: 20,
    payload: {add_work: "run regression suite"},
  };
  const first = enqueueMissionAmendmentRequest(input);
  const second = enqueueMissionAmendmentRequest(input);
  assert.equal(first.run_id, "RUN-001");
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(second.queue_revision, first.queue_revision);
  assert.throws(() => parseMissionAmendArgs(["--shell", "whoami"]), /unknown argument/);
}));

test("launch request is durable/idempotent and rejects changed same-key request", () => withRoot(root => {
  const control = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  const first = launchRequest(control);
  const second = launchRequest(control);
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(readMissionLaunchState(control).launches.length, 1);
  assert.throws(
    () => launchRequest(control, {goal: "changed goal"}),
    /LAUNCH_IDEMPOTENCY_KEY_CONFLICT/,
  );
}));

test("launch intent cannot cross unsafe or ambiguous action boundary", () => withRoot(root => {
  const control = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  assert.throws(() => launchRequest(control, {boundary: {safe: false}}), /MISSION_LAUNCH_UNSAFE_BOUNDARY/);
  assert.throws(
    () => launchRequest(control, {boundary: {safe: true, ambiguous_action: true}}),
    /MISSION_LAUNCH_BLOCKED_BY_IN_FLIGHT_ACTION/,
  );
}));

test("two-phase launch fence survives reopen and blocks another attempt", () => withRoot(root => {
  let control = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  const launch = launchRequest(control).launch;
  beginMissionChildLaunch(control, launch.launch_id, {
    launch_attempt_id: "ATTEMPT-001", launcher_request_id: "REQ-001", lease_token: "LEASE-001",
  });
  control = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  assert.equal(readMissionLaunchState(control).launches[0].status, "LAUNCHING");
  assert.throws(
    () => beginMissionChildLaunch(control, launch.launch_id, {
      launch_attempt_id: "ATTEMPT-002", launcher_request_id: "REQ-002",
    }),
    /MISSION_LAUNCH_IN_FLIGHT/,
  );
}));

test("launch receipt blocks sibling until child lineage confirms", () => withRoot(root => {
  let control = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  const launch = launchRequest(control).launch;
  beginMissionChildLaunch(control, launch.launch_id, {
    launch_attempt_id: "ATTEMPT-001", launcher_request_id: "REQ-001", lease_token: "LEASE-001",
  });
  completeMissionChildLaunch(control, launch.launch_id, {
    launch_attempt_id: "ATTEMPT-001", receipt: {pid: 1234},
  });
  assert.throws(
    () => launchRequest(control, {launch_id: "LAUNCH-002", idempotency_key: "launch-002", child_run_id: "RUN-003"}),
    /MISSION_LAUNCH_ACTIVE/,
  );
  control = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-002", parent_run_id: "RUN-001"});
  assert.equal(reconcileMissionChildLaunches(control).changed, true);
  assert.equal(readMissionLaunchState(control).launches[0].status, "CONFIRMED");
}));

test("dispatcher persists LAUNCHING before spawn and records receipt", () => withRoot(async root => {
  const control = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  const launch = launchRequest(control).launch;
  let unrefCalled = false;
  const fakeSpawn = () => {
    assert.equal(readMissionLaunchState(control).launches[0].status, "LAUNCHING");
    const child = new EventEmitter();
    child.pid = 4242;
    child.unref = () => { unrefCalled = true; };
    process.nextTick(() => child.emit("spawn"));
    return child;
  };
  const result = await dispatchMissionChildLaunch(control, launch, {
    launch_attempt_id: "ATTEMPT-001",
    launcher_request_id: "REQ-001",
    entry_path: "C:/repo/tools/devexec-goal.mjs",
    spawn_impl: fakeSpawn,
  });
  assert.equal(result.launch.status, "LAUNCHED");
  assert.equal(result.receipt.pid, 4242);
  assert.equal(unrefCalled, true);
}));

test("spawn error becomes durable ambiguous instead of replayable pending", () => withRoot(async root => {
  const control = openMissionControl({base: root, mission_id: "MISSION-001", run_id: "RUN-001"});
  const launch = launchRequest(control).launch;
  const fakeSpawn = () => {
    const child = new EventEmitter();
    process.nextTick(() => {
      const error = new Error("spawn failed");
      error.code = "ENOENT";
      child.emit("error", error);
    });
    return child;
  };
  await assert.rejects(
    dispatchMissionChildLaunch(control, launch, {
      launch_attempt_id: "ATTEMPT-001",
      launcher_request_id: "REQ-001",
      entry_path: "missing.mjs",
      spawn_impl: fakeSpawn,
    }),
    /MISSION_LAUNCH_DISPATCH_AMBIGUOUS/,
  );
  assert.equal(readMissionLaunchState(control).launches[0].status, "AMBIGUOUS");
}));
