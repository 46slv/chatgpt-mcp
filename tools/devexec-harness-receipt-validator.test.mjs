import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runOuterCycles } from "./devexec-harness-adapter.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA2 = "89abcdef0123456789abcdef0123456789abcdef";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-harness-receipt-strict-"));
  return {
    root,
    file: path.join(root, "outer.json"),
    binding: {
      harness_repository: root,
      harness_commit_sha: SHA,
      target_repository: root,
      target_ref: "main",
      target_base_sha: SHA2,
      working_directory: root,
      evidence_root: path.join(root, "evidence"),
    },
  };
}

const common = (f, extra = {}) => ({
  receiptFile: f.file,
  outer_run_id: "outer-strict",
  binding: f.binding,
  goal_identity: "goal-1",
  task_identity: "task-1",
  maxCycles: 2,
  launchCycle: async () => ({ status: "DONE", evidence: { next_action: "STOP" } }),
  ...extra,
});

async function seedRunningReceipt(f) {
  await assert.rejects(
    () => runOuterCycles(common(f, {
      launchCycle: async () => ({ status: "DONE", evidence: { next_action: "localized_retry" } }),
      crashAfterCycle: 0,
    })),
    /SIMULATED_CRASH_AFTER_DURABLE_RECEIPT/,
  );
  return JSON.parse(fs.readFileSync(f.file, "utf8"));
}

function writeReceipt(f, receipt) {
  fs.writeFileSync(f.file, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

test("persisted receipt rejects schema-forbidden project_next_action before resume launch", async () => {
  const f = fixture();
  const receipt = await seedRunningReceipt(f);
  delete receipt.cycles[0].next_action;
  receipt.cycles[0].project_next_action = "CONTINUE";
  writeReceipt(f, receipt);
  let calls = 0;
  await assert.rejects(
    () => runOuterCycles(common(f, { launchCycle: async () => { calls += 1; return {}; } })),
    /OUTER_CYCLE_UNKNOWN_FIELD:project_next_action/,
  );
  assert.equal(calls, 0);
});

test("persisted receipt rejects missing schema-required cycle field before resume launch", async () => {
  const f = fixture();
  const receipt = await seedRunningReceipt(f);
  delete receipt.cycles[0].verifier_status;
  writeReceipt(f, receipt);
  let calls = 0;
  await assert.rejects(
    () => runOuterCycles(common(f, { launchCycle: async () => { calls += 1; return {}; } })),
    /OUTER_CYCLE_REQUIRED_FIELD_MISSING:verifier_status/,
  );
  assert.equal(calls, 0);
});

test("persisted receipt rejects unknown cycle field before resume launch", async () => {
  const f = fixture();
  const receipt = await seedRunningReceipt(f);
  receipt.cycles[0].shell = "powershell";
  writeReceipt(f, receipt);
  let calls = 0;
  await assert.rejects(
    () => runOuterCycles(common(f, { launchCycle: async () => { calls += 1; return {}; } })),
    /OUTER_CYCLE_UNKNOWN_FIELD:shell/,
  );
  assert.equal(calls, 0);
});

test("persisted receipt rejects unknown top-level field before resume launch", async () => {
  const f = fixture();
  const receipt = await seedRunningReceipt(f);
  receipt.resume_override = true;
  writeReceipt(f, receipt);
  let calls = 0;
  await assert.rejects(
    () => runOuterCycles(common(f, { launchCycle: async () => { calls += 1; return {}; } })),
    /OUTER_RECEIPT_UNKNOWN_FIELD:resume_override/,
  );
  assert.equal(calls, 0);
});

test("persisted receipt rejects cycle count beyond recorded max before resume launch", async () => {
  const f = fixture();
  const receipt = await seedRunningReceipt(f);
  receipt.cycles.push({ ...receipt.cycles[0], cycle_index: 1, child_run_id: "outer-strict-cycle-1" });
  receipt.cycles.push({ ...receipt.cycles[0], cycle_index: 2, child_run_id: "outer-strict-cycle-2" });
  writeReceipt(f, receipt);
  let calls = 0;
  await assert.rejects(
    () => runOuterCycles(common(f, { launchCycle: async () => { calls += 1; return {}; } })),
    /OUTER_CYCLE_COUNT_EXCEEDS_MAX/,
  );
  assert.equal(calls, 0);
});

test("persisted receipt rejects schema-invalid cycle types before resume launch", async () => {
  const f = fixture();
  const receipt = await seedRunningReceipt(f);
  receipt.cycles[0].fast_path_eligible = "false";
  writeReceipt(f, receipt);
  let calls = 0;
  await assert.rejects(
    () => runOuterCycles(common(f, { launchCycle: async () => { calls += 1; return {}; } })),
    /OUTER_CYCLE_FAST_PATH_INVALID/,
  );
  assert.equal(calls, 0);
});

test("valid strict persisted receipt resumes exactly once and remains bounded", async () => {
  const f = fixture();
  await seedRunningReceipt(f);
  let calls = 0;
  const resumed = await runOuterCycles(common(f, {
    launchCycle: async () => {
      calls += 1;
      return { status: "DONE", evidence: { next_action: "STOP" } };
    },
  }));
  assert.equal(calls, 1);
  assert.equal(resumed.receipt.cycles.length, 2);
  assert.equal(resumed.receipt.status, "COMPLETE");
});
