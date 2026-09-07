import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectOuterLeaseState, runOuterCycles } from "./devexec-harness-adapter.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA2 = "89abcdef0123456789abcdef0123456789abcdef";

function fixture(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `devexec-lease-inspect-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const evidenceRoot = path.join(root, "evidence");
  const workingDirectory = path.join(root, "work");
  fs.mkdirSync(evidenceRoot, { recursive: true });
  fs.mkdirSync(workingDirectory, { recursive: true });
  const receiptFile = path.join(root, "outer.json");
  return {
    root,
    receiptFile,
    leaseDirectory: `${path.resolve(receiptFile)}.lease`,
    ownerFile: `${path.resolve(receiptFile)}.lease${path.sep}owner.json`,
    binding: {
      harness_repository: path.join(root, "harness"),
      harness_commit_sha: SHA,
      target_repository: path.join(root, "target"),
      target_ref: "automation/test-target",
      target_base_sha: SHA2,
      working_directory: workingDirectory,
      evidence_root: evidenceRoot,
    },
  };
}

function options(f) {
  return {
    receiptFile: f.receiptFile,
    outer_run_id: "outer-single-flight",
    binding: f.binding,
    goal_identity: "goal-1",
    task_identity: "task-1",
    project_adapter: "json",
    maxCycles: 1,
  };
}

function writeOwner(f, overrides = {}) {
  fs.mkdirSync(f.leaseDirectory, { recursive: true });
  const owner = {
    schema: "devexec.harness-outer-lease.v1",
    owner_token: "owner-token",
    process_id: 424242,
    receipt_file: path.resolve(f.receiptFile),
    outer_run_id: "outer-single-flight",
    goal_identity: "goal-1",
    task_identity: "task-1",
    project_adapter: "json",
    harness_commit_sha: SHA,
    target_base_sha: SHA2,
    target_ref: "automation/test-target",
    acquired_at: new Date().toISOString(),
    ...overrides,
  };
  fs.writeFileSync(f.ownerFile, `${JSON.stringify(owner, null, 2)}\n`, "utf8");
  return owner;
}

function writeReceipt(f, { pending = false } = {}) {
  const started = new Date().toISOString();
  const receipt = {
    schema: "devexec.harness-outer.v1",
    outer_run_id: "outer-single-flight",
    goal_identity: "goal-1",
    task_identity: "task-1",
    project_adapter: "json",
    max_cycles: 1,
    status: "RUNNING",
    created_at: started,
    updated_at: started,
    harness_binding: f.binding,
    pending_cycle: pending ? {
      cycle_index: 0,
      child_run_id: "outer-single-flight-cycle-0",
      harness_repository: f.binding.harness_repository,
      harness_commit_sha: SHA,
      target_repository: f.binding.target_repository,
      target_ref: f.binding.target_ref,
      target_base_sha: SHA2,
      working_directory: f.binding.working_directory,
      evidence_root: f.binding.evidence_root,
      project_adapter: "json",
      input_state_hash: "a".repeat(64),
      task_id: "task-1",
      goal_id: "goal-1",
      started_at: started,
    } : null,
    cycles: [],
  };
  fs.writeFileSync(f.receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receipt;
}

async function assertParseableMalformedReceiptFailsClosed(t, name, mutate, expectedError) {
  const f = fixture(t, name);
  writeOwner(f);
  const receipt = writeReceipt(f);
  mutate(receipt);
  fs.writeFileSync(f.receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  const receiptBefore = fs.readFileSync(f.receiptFile, "utf8");
  const ownerBefore = fs.readFileSync(f.ownerFile, "utf8");

  const inspection = inspectOuterLeaseState(options(f), { isProcessAlive: () => false });
  assert.equal(inspection.state, "DEAD_VALID_OWNER_RECEIPT_AMBIGUOUS");
  assert.equal(inspection.receipt_state, "AMBIGUOUS");
  assert.match(inspection.reason, expectedError);

  let launches = 0;
  await assert.rejects(
    () => runOuterCycles({
      ...options(f),
      launchCycle: async () => {
        launches += 1;
        return {};
      },
    }),
    (error) => error?.code === "OUTER_RUN_LEASE_HELD" && error?.message === "OUTER_RUN_LEASE_HELD",
  );
  assert.equal(launches, 0);
  assert.equal(fs.readFileSync(f.receiptFile, "utf8"), receiptBefore);
  assert.equal(fs.readFileSync(f.ownerFile, "utf8"), ownerBefore);
  assert.equal(fs.existsSync(f.leaseDirectory), true);
}

test("live matching owner is inspectable without mutating lease or receipt", (t) => {
  const f = fixture(t, "live");
  writeOwner(f);
  const before = fs.readFileSync(f.ownerFile, "utf8");
  const state = inspectOuterLeaseState(options(f), { isProcessAlive: () => true });
  assert.equal(state.state, "LIVE_MATCHING_OWNER");
  assert.equal(state.receipt_state, "ABSENT");
  assert.equal(fs.readFileSync(f.ownerFile, "utf8"), before);
  assert.equal(fs.existsSync(f.receiptFile), false);
});

test("malformed or mismatched owner is explicit ambiguous and read-only", (t) => {
  const f = fixture(t, "ambiguous-owner");
  writeOwner(f, { task_identity: "wrong-task" });
  const state = inspectOuterLeaseState(options(f), { isProcessAlive: () => false });
  assert.equal(state.state, "AMBIGUOUS_OWNER");
  assert.match(state.reason, /IDENTITY_MISMATCH:task_identity/);
  assert.equal(fs.existsSync(f.receiptFile), false);
});

test("valid dead owner with no receipt is explicit orphan residue", (t) => {
  const f = fixture(t, "dead-no-receipt");
  writeOwner(f);
  const state = inspectOuterLeaseState(options(f), { isProcessAlive: () => false });
  assert.equal(state.state, "DEAD_VALID_OWNER_RECEIPT_ABSENT");
  assert.equal(state.receipt_state, "ABSENT");
  assert.equal(fs.existsSync(f.receiptFile), false);
  assert.equal(fs.existsSync(f.leaseDirectory), true);
});

test("valid dead owner with pending receipt is distinguished from pre-receipt orphan", (t) => {
  const f = fixture(t, "dead-pending");
  writeOwner(f);
  writeReceipt(f, { pending: true });
  const state = inspectOuterLeaseState(options(f), { isProcessAlive: () => false });
  assert.equal(state.state, "DEAD_VALID_OWNER_PENDING_RECEIPT");
  assert.equal(state.receipt_state, "PENDING");
  assert.equal(state.receipt_status, "RUNNING");
});

test("unknown owner liveness remains ambiguous and fail closed", (t) => {
  const f = fixture(t, "unknown-liveness");
  writeOwner(f);
  const state = inspectOuterLeaseState(options(f), { isProcessAlive: () => null });
  assert.equal(state.state, "AMBIGUOUS_LIVENESS");
  assert.equal(state.receipt_state, "ABSENT");
});

test("pre-receipt dead-owner classification never authorizes replay or receipt mutation", async (t) => {
  const f = fixture(t, "no-replay");
  writeOwner(f);
  const inspection = inspectOuterLeaseState(options(f), { isProcessAlive: () => false });
  assert.equal(inspection.state, "DEAD_VALID_OWNER_RECEIPT_ABSENT");
  let launches = 0;
  await assert.rejects(
    () => runOuterCycles({
      ...options(f),
      launchCycle: async () => {
        launches += 1;
        return {};
      },
    }),
    (error) => error?.code === "OUTER_RUN_LEASE_HELD" && error?.message === "OUTER_RUN_LEASE_HELD",
  );
  assert.equal(launches, 0);
  assert.equal(fs.existsSync(f.receiptFile), false);
  assert.equal(fs.existsSync(f.leaseDirectory), true);
});

test("no lease is explicit and inspection does not create parent state", (t) => {
  const f = fixture(t, "no-lease");
  const state = inspectOuterLeaseState(options(f), { isProcessAlive: () => { throw new Error("must not probe"); } });
  assert.equal(state.state, "NO_LEASE");
  assert.equal(state.receipt_state, "ABSENT");
  assert.equal(fs.existsSync(f.leaseDirectory), false);
  assert.equal(fs.existsSync(f.receiptFile), false);
});

test("valid dead owner with non-pending receipt remains explicit residue and does not authorize recovery", (t) => {
  const f = fixture(t, "dead-receipt-present");
  writeOwner(f);
  writeReceipt(f, { pending: false });
  const receiptBefore = fs.readFileSync(f.receiptFile, "utf8");
  const state = inspectOuterLeaseState(options(f), { isProcessAlive: () => false });
  assert.equal(state.state, "DEAD_VALID_OWNER_RECEIPT_PRESENT");
  assert.equal(state.receipt_state, "PRESENT_NO_PENDING");
  assert.equal(state.receipt_status, "RUNNING");
  assert.equal(fs.readFileSync(f.receiptFile, "utf8"), receiptBefore);
  assert.equal(fs.existsSync(f.leaseDirectory), true);
});

test("valid dead owner with malformed receipt is explicit ambiguous residue", (t) => {
  const f = fixture(t, "dead-ambiguous-receipt");
  writeOwner(f);
  fs.writeFileSync(f.receiptFile, "{not-json\n", "utf8");
  const receiptBefore = fs.readFileSync(f.receiptFile, "utf8");
  const state = inspectOuterLeaseState(options(f), { isProcessAlive: () => false });
  assert.equal(state.state, "DEAD_VALID_OWNER_RECEIPT_AMBIGUOUS");
  assert.equal(state.receipt_state, "AMBIGUOUS");
  assert.equal(fs.readFileSync(f.receiptFile, "utf8"), receiptBefore);
  assert.equal(fs.existsSync(f.leaseDirectory), true);
});

test("parseable receipt missing a canonical required field is ambiguous and cannot replay", async (t) => {
  await assertParseableMalformedReceiptFailsClosed(
    t,
    "dead-parseable-missing-field",
    (receipt) => { delete receipt.max_cycles; },
    /OUTER_RECEIPT_REQUIRED_FIELD_MISSING:max_cycles/,
  );
});

test("parseable receipt with invalid status is ambiguous and cannot replay", async (t) => {
  await assertParseableMalformedReceiptFailsClosed(
    t,
    "dead-parseable-invalid-status",
    (receipt) => { receipt.status = "BROKEN"; },
    /OUTER_STATUS_INVALID/,
  );
});

test("parseable receipt with malformed pending cycle is ambiguous and cannot replay", async (t) => {
  await assertParseableMalformedReceiptFailsClosed(
    t,
    "dead-parseable-invalid-pending",
    (receipt) => { receipt.pending_cycle = { cycle_index: 0 }; },
    /OUTER_PENDING_CYCLE_REQUIRED_FIELD_MISSING:child_run_id/,
  );
});
