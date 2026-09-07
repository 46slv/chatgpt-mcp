import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  DevExecMissionStore,
  OPERATOR_EVENT_PROTOCOL,
} from "./devexec-mission-store.mjs";

const BINDING = `sha256:${"a".repeat(64)}`;
const PAYLOAD = `sha256:${"1".repeat(64)}`;
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-transition-race-"));
}

function operatorEvent({ eventId, requestId, idempotencyKey, kind = "operator.request.submitted", missionId = null }) {
  return {
    protocol: OPERATOR_EVENT_PROTOCOL,
    schema_version: 1,
    event_id: eventId,
    request_id: requestId,
    idempotency_key: idempotencyKey,
    kind,
    occurred_at: "2026-09-07T07:00:00+09:00",
    source: { type: "operator", adapter: "mission-console", binding_id: BINDING },
    subject: { mission_id: missionId },
    intent: "TASK",
    requested_authority: kind === "operator.followup.submitted" ? "READ_ONLY" : "BOUNDED_WRITE",
    payload_ref: { sha256: PAYLOAD, location: `runtime-payload/${eventId}` },
    correlation_id: `corr-${eventId}`,
  };
}

function completePayload(summary) {
  return {
    status: "COMPLETE",
    summary,
    changed_surface: ["tools/devexec-mission-store.mjs"],
    evidence_refs: ["test:mission-transition-race"],
    remaining_limits: [],
    episode_aggregate: { episode_count: 0, runtime_classes: [], escalation_count: 0 },
  };
}

function spawnWorker({ root, missionId, action, marker, release, event = null, completion = null }) {
  const storeUrl = new URL("./devexec-mission-store.mjs", import.meta.url).href;
  const source = String.raw`
import fs from "node:fs";
const SLEEP = new Int32Array(new SharedArrayBuffer(4));
const { DevExecMissionStore } = await import(process.env.STORE_URL);
let tick = Date.parse("2026-09-07T00:00:00.000Z");
let blocked = false;
const now = () => {
  if (!blocked) {
    blocked = true;
    fs.writeFileSync(process.env.MARKER, "LOCK_HELD\n", "utf8");
    while (!fs.existsSync(process.env.RELEASE)) Atomics.wait(SLEEP, 0, 0, 5);
  }
  const value = new Date(tick);
  tick += 1000;
  return value;
};
const store = new DevExecMissionStore({
  stateDir: process.env.ROOT,
  now,
  transitionLockTimeoutMs: 5000,
  transitionLockPollMs: 5,
});
try {
  let value;
  if (process.env.ACTION === "complete") {
    value = store.completeMission(process.env.MISSION_ID, JSON.parse(process.env.COMPLETION));
  } else {
    value = store.submitOperatorEvent(JSON.parse(process.env.EVENT));
  }
  process.stdout.write(JSON.stringify({ ok: true, value }) + "\n");
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error?.code || null, message: String(error?.message || error) }) + "\n");
}
`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    env: {
      ...process.env,
      STORE_URL: storeUrl,
      ROOT: root,
      MISSION_ID: missionId,
      ACTION: action,
      MARKER: marker,
      RELEASE: release,
      EVENT: JSON.stringify(event),
      COMPLETION: JSON.stringify(completion),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(`worker exited ${code}: ${stderr}`));
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      try { resolve(JSON.parse(line)); }
      catch (error) { reject(new Error(`invalid worker output: ${stdout}\n${stderr}`, { cause: error })); }
    });
  });
  return { child, done };
}

async function waitForFile(file, workers, timeoutMs = 5000) {
  const started = Date.now();
  while (!fs.existsSync(file)) {
    if (Date.now() - started >= timeoutMs) {
      for (const worker of workers) worker.child.kill();
      throw new Error(`timed out waiting for ${file}`);
    }
    Atomics.wait(SLEEP_CELL, 0, 0, 5);
    await Promise.resolve();
  }
}

test("completion holding the Mission lock commits before a racing follow-up, which is then terminal-rejected", { timeout: 15000 }, async () => {
  const root = tmp();
  const store = new DevExecMissionStore({ stateDir: root, now: () => new Date("2026-09-06T23:59:00.000Z") });
  const created = store.submitOperatorEvent(operatorEvent({ eventId: "evt-race-a", requestId: "req-race-a", idempotencyKey: "idem-race-a" }));
  const marker = path.join(root, "completion-held.marker");
  const release = path.join(root, "completion-release.marker");
  const completionWorker = spawnWorker({
    root,
    missionId: created.mission_id,
    action: "complete",
    marker,
    release,
    completion: completePayload("completion wins"),
  });
  await waitForFile(marker, [completionWorker]);

  const follow = operatorEvent({
    eventId: "evt-race-a-follow",
    requestId: "req-race-a-follow",
    idempotencyKey: "idem-race-a-follow",
    kind: "operator.followup.submitted",
    missionId: created.mission_id,
  });
  const followMarker = path.join(root, "follow-a-held.marker");
  const followRelease = path.join(root, "follow-a-release.marker");
  const followWorker = spawnWorker({
    root,
    missionId: created.mission_id,
    action: "followup",
    marker: followMarker,
    release: followRelease,
    event: follow,
  });
  Atomics.wait(SLEEP_CELL, 0, 0, 50);
  fs.writeFileSync(release, "GO\n", "utf8");
  await waitForFile(followMarker, [followWorker]);
  fs.writeFileSync(followRelease, "GO\n", "utf8");

  const [completionResult, followResult] = await Promise.all([completionWorker.done, followWorker.done]);
  assert.equal(completionResult.ok, true);
  assert.equal(completionResult.value.status, "COMMITTED");
  assert.equal(followResult.ok, true);
  assert.equal(followResult.value.status, "REJECTED");
  assert.equal(followResult.value.reason_code, "MISSION_TERMINAL");

  const reopened = new DevExecMissionStore({ stateDir: root });
  assert.equal(reopened.readMissionResult(created.mission_id).status, "COMPLETE");
  assert.deepEqual(reopened.readMission(created.mission_id).deferred_event_ids, []);
  assert.equal(reopened.verifyDurableState().valid, true);
});

test("follow-up holding the Mission lock defers before a racing completion, which then refuses the pending event", { timeout: 15000 }, async () => {
  const root = tmp();
  const store = new DevExecMissionStore({ stateDir: root, now: () => new Date("2026-09-06T23:59:00.000Z") });
  const created = store.submitOperatorEvent(operatorEvent({ eventId: "evt-race-b", requestId: "req-race-b", idempotencyKey: "idem-race-b" }));
  const follow = operatorEvent({
    eventId: "evt-race-b-follow",
    requestId: "req-race-b-follow",
    idempotencyKey: "idem-race-b-follow",
    kind: "operator.followup.submitted",
    missionId: created.mission_id,
  });
  const marker = path.join(root, "follow-b-held.marker");
  const release = path.join(root, "follow-b-release.marker");
  const followWorker = spawnWorker({ root, missionId: created.mission_id, action: "followup", marker, release, event: follow });
  await waitForFile(marker, [followWorker]);

  const completionMarker = path.join(root, "completion-b-held.marker");
  const completionWorker = spawnWorker({
    root,
    missionId: created.mission_id,
    action: "complete",
    marker: completionMarker,
    release: path.join(root, "completion-b-release.marker"),
    completion: completePayload("must refuse"),
  });
  Atomics.wait(SLEEP_CELL, 0, 0, 50);
  fs.writeFileSync(release, "GO\n", "utf8");
  const followResult = await followWorker.done;
  assert.equal(followResult.ok, true);
  assert.equal(followResult.value.status, "DEFERRED");

  // Completion can acquire only after follow-up releases the Mission lock.
  // Its facade-level deferred guard then fails before core completion calls now().
  const completionResult = await completionWorker.done;
  assert.equal(fs.existsSync(completionMarker), false);
  assert.equal(completionResult.ok, false);
  assert.equal(completionResult.code, "DEFERRED_EVENTS_PENDING");

  const reopened = new DevExecMissionStore({ stateDir: root });
  assert.equal(reopened.readMissionResult(created.mission_id), null);
  assert.deepEqual(reopened.readMission(created.mission_id).deferred_event_ids, [follow.event_id]);
  assert.equal(reopened.verifyDurableState().valid, true);
});
