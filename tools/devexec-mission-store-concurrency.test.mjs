import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DevExecMissionStore, OPERATOR_EVENT_PROTOCOL } from "./devexec-mission-store.mjs";

const STORE_URL = new URL("./devexec-mission-store.mjs", import.meta.url).href;
const BINDING = `sha256:${"c".repeat(64)}`;
const PAYLOAD = `sha256:${"2".repeat(64)}`;

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-store-process-race-"));
}

function operatorEvent() {
  return {
    protocol: OPERATOR_EVENT_PROTOCOL,
    schema_version: 1,
    event_id: "evt-process-race",
    request_id: "req-process-race",
    idempotency_key: "idem-process-race",
    kind: "operator.request.submitted",
    occurred_at: "2026-09-03T21:30:00+09:00",
    source: { type: "operator", adapter: "mission-concurrency-test", binding_id: BINDING },
    subject: { mission_id: null },
    intent: "TASK",
    requested_authority: "BOUNDED_WRITE",
    payload_ref: { sha256: PAYLOAD, location: "runtime-payload/evt-process-race" },
    correlation_id: "corr-process-race",
  };
}

function submitFromChild(stateDir, event) {
  const script = `
    import { DevExecMissionStore } from ${JSON.stringify(STORE_URL)};
    const store = new DevExecMissionStore({ stateDir: process.env.DEVEXEC_TEST_STATE_DIR });
    const event = JSON.parse(process.env.DEVEXEC_TEST_EVENT);
    const receipt = store.submitOperatorEvent(event);
    process.stdout.write(JSON.stringify(receipt));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: {
        ...process.env,
        DEVEXEC_TEST_STATE_DIR: stateDir,
        DEVEXEC_TEST_EVENT: JSON.stringify(event),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`child exited ${code}: ${stderr || stdout}`));
        return;
      }
      try { resolve(JSON.parse(stdout)); }
      catch (error) { reject(new Error(`child returned invalid JSON: ${stdout}; ${String(error)}`)); }
    });
  });
}

test("cross-process duplicate submission creates exactly one Mission and never replays work", async () => {
  const root = tmp();
  const event = operatorEvent();
  const receipts = await Promise.all(
    Array.from({ length: 12 }, () => submitFromChild(root, event)),
  );

  const applied = receipts.filter((receipt) => receipt.status === "APPLIED");
  assert.equal(applied.length, 1, `expected one admission winner, got ${JSON.stringify(receipts)}`);
  for (const receipt of receipts) {
    assert.ok(["APPLIED", "DUPLICATE", "BLOCKED"].includes(receipt.status));
    if (receipt.status === "BLOCKED") {
      assert.ok([
        "IDEMPOTENCY_IN_FLIGHT",
        "INCOMPLETE_IDEMPOTENCY_CLAIM",
      ].includes(receipt.reason_code), `unexpected concurrent blocker ${JSON.stringify(receipt)}`);
    }
  }

  const store = new DevExecMissionStore({ stateDir: root });
  const health = store.verifyDurableState();
  assert.equal(health.valid, true, JSON.stringify(health));
  assert.equal(store.listMissions().length, 1);
  assert.equal(store.listEvents().length, 1);
  assert.equal(store.listEvents()[0].status, "APPLIED");
  assert.deepEqual(store.listMissions()[0].applied_event_ids, [event.event_id]);

  const retry = store.submitOperatorEvent(event);
  assert.equal(retry.status, "DUPLICATE");
  assert.equal(retry.canonical_status, "APPLIED");
  assert.equal(retry.mission_id, applied[0].mission_id);
  assert.equal(store.listMissions().length, 1);
  assert.equal(store.listEvents().length, 1);
});
