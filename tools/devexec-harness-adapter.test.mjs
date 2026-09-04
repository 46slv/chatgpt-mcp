import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHarnessLauncher, createOuterReceipt, dedupeOuterCycle, runOuterCycles, verifyHarnessBinding } from "./devexec-harness-adapter.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA2 = "89abcdef0123456789abcdef0123456789abcdef";
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-harness-adapter-"));
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
const common = (f, extra = {}) => ({ receiptFile: f.file, outer_run_id: "outer-test", binding: f.binding, goal_identity: "goal-1", task_identity: "task-1", launchCycle: async () => ({ status: "DONE", evidence: { next_action: "STOP" } }), ...extra });

test("outer adapter runs two bounded cycles using only recorded runtime binding and does not persist role contexts", async () => {
  const f = fixture(); const calls = [];
  const launchCycle = async (r) => {
    calls.push(r);
    return { status: "DONE", evidence: { status: "DONE", role_contexts: { worker: "raw-context-must-not-persist" }, fast_path_eligible: r.cycle_index === 1, skipped_roles: r.cycle_index === 1 ? ["manager-locate", "manager-plan"] : [], launched_roles: ["worker", "verifier"], next_action: r.cycle_index === 0 ? "localized_retry" : "STOP" } };
  };
  const out = await runOuterCycles(common(f, { launchCycle }));
  assert.equal(out.receipt.status, "COMPLETE");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].working_directory, f.binding.working_directory);
  assert.equal(calls[0].evidence_root, f.binding.evidence_root);
  assert.equal(calls[0].target_base_sha, f.binding.target_base_sha);
  assert.equal(out.receipt.cycles[0].resulting_state_hash, out.receipt.cycles[1].input_state_hash);
  assert.equal(Object.hasOwn(out.receipt.cycles[0], "role_contexts"), false);
  assert.equal(out.receipt.cycles[0].transcripts_forwarded, false);
});

test("restart resumes exact durable identity without replay and rejects identity drift", async () => {
  const f = fixture(); const calls = [];
  const launchCycle = async (r) => { calls.push(r); return { status: "DONE", evidence: { next_action: "localized_retry" } }; };
  await assert.rejects(() => runOuterCycles(common(f, { outer_run_id: "outer-restart", launchCycle, crashAfterCycle: 0 })), /SIMULATED_CRASH/);
  await assert.rejects(() => runOuterCycles(common(f, { outer_run_id: "outer-restart", task_identity: "different-task", launchCycle })), /OUTER_IDENTITY_MISMATCH:task_identity/);
  const resumed = await runOuterCycles(common(f, { outer_run_id: "outer-restart", launchCycle }));
  assert.equal(calls.length, 2);
  assert.equal(resumed.receipt.cycles.length, 2);
  assert.equal(resumed.receipt.cycles[0].child_run_id, "outer-restart-cycle-0");
});

test("recorded binding cannot diverge from runtime arguments or resume binding", async () => {
  const f = fixture(); let calls = 0;
  const launchCycle = async () => { calls += 1; return { status: "DONE", evidence: { next_action: "STOP" } }; };
  await assert.rejects(() => runOuterCycles(common(f, { working_directory: path.join(f.root, "other"), launchCycle })), /RUNTIME_BINDING_MISMATCH:working_directory/);
  assert.equal(calls, 0);
  createOuterReceipt({ outer_run_id: "bound", binding: f.binding, file: f.file, goal_identity: "goal-1", task_identity: "task-1", project_adapter: "json", maxCycles: 2 });
  await assert.rejects(() => runOuterCycles(common(f, { outer_run_id: "bound", binding: { ...f.binding, target_base_sha: SHA }, launchCycle })), /OUTER_BINDING_MISMATCH/);
  assert.equal(calls, 0);
});

test("budget exhaustion blocks the first child launch", async () => {
  const f = fixture(); let calls = 0;
  const out = await runOuterCycles(common(f, { budgetAvailable: false, launchCycle: async () => { calls += 1; return {}; } }));
  assert.equal(calls, 0);
  assert.equal(out.receipt.status, "COMPLETE");
  assert.equal(out.decision.reason, "BUDGET_EXHAUSTED");
});

test("non-zero harness child exit fails closed before durable acceptance", async () => {
  const f = fixture();
  await assert.rejects(() => runOuterCycles(common(f, { launchCycle: async () => ({ exit_code: 9, status: "DONE", evidence: { next_action: "STOP" } }) })), /HARNESS_EXIT_NONZERO:9/);
  const persisted = JSON.parse(fs.readFileSync(f.file, "utf8"));
  assert.equal(persisted.cycles.length, 0);
  assert.equal(persisted.status, "RUNNING");
});

test("source drift stops before a child and dedupe helper remains idempotent", async () => {
  const f = fixture(); let calls = 0;
  const out = await runOuterCycles(common(f, { sourceDriftCheck: () => true, launchCycle: async () => { calls += 1; return {}; } }));
  assert.equal(calls, 0);
  assert.equal(out.receipt.cycles.length, 0);
  assert.equal(out.receipt.status, "NEEDS_HUMAN");
  const r = createOuterReceipt({ outer_run_id: "x", binding: f.binding, goal_identity: "g", task_identity: "t" });
  r.cycles.push({ cycle_index: 1, input_state_hash: "a", harness_commit_sha: SHA });
  assert.ok(dedupeOuterCycle(r, { cycle_index: 1, input_state_hash: "a", harness_commit_sha: SHA }));
});

test("real launcher boundary verifies the exact harness checkout before launch", async () => {
  const f = fixture(); let calls = 0;
  const mismatch = createHarnessLauncher({ harnessRoot: f.root, resolveHarnessCommit: () => SHA2, launch: async () => { calls += 1; return {}; } });
  await assert.rejects(() => mismatch({ harness_repository: f.root, harness_commit_sha: SHA }), /HARNESS_COMMIT_MISMATCH/);
  assert.equal(calls, 0);
  const exact = createHarnessLauncher({ harnessRoot: f.root, resolveHarnessCommit: () => SHA, launch: async () => { calls += 1; return { status: "DONE" }; } });
  await exact({ harness_repository: f.root, harness_commit_sha: SHA });
  assert.equal(calls, 1);
});

test("cycle evidence files are confined to the recorded evidence root", async () => {
  const f = fixture();
  const outside = path.join(f.root, "outside.json");
  fs.writeFileSync(outside, "{}", "utf8");
  await assert.rejects(() => runOuterCycles(common(f, { launchCycle: async () => ({ status: "DONE", evidence_path: outside, evidence: { next_action: "STOP" } }) })), /EVIDENCE_PATH_OUTSIDE_ROOT/);
  const persisted = JSON.parse(fs.readFileSync(f.file, "utf8"));
  assert.equal(persisted.cycles.length, 0);
});

test("binding requires exact harness and target SHAs and rejects unknown authority fields", () => {
  const f = fixture();
  assert.throws(() => verifyHarnessBinding({ ...f.binding, harness_commit_sha: "short" }), /full SHA/);
  assert.throws(() => verifyHarnessBinding({ ...f.binding, target_base_sha: "short" }), /target_base_sha/);
  assert.throws(() => verifyHarnessBinding({ ...f.binding, shell: "powershell" }), /unknown field:shell/);
});

test("outer cycle bound is explicit and mechanically capped", async () => {
  const f = fixture();
  await assert.rejects(() => runOuterCycles(common(f, { maxCycles: 0 })), /maxCycles/);
  await assert.rejects(() => runOuterCycles(common(f, { maxCycles: 65 })), /maxCycles/);
});

test("durable receipt schema formally excludes raw contexts and unknown cycle fields", () => {
  const schema = JSON.parse(fs.readFileSync(new URL("./devexec-harness-outer.v1.schema.json", import.meta.url), "utf8"));
  const item = schema.properties.cycles.items;
  assert.equal(item.additionalProperties, false);
  assert.equal(Object.hasOwn(item.properties, "role_contexts"), false);
  assert.equal(Object.hasOwn(item.properties, "transcripts"), false);
  for (const key of ["cycle_evidence_hash", "task_id", "goal_id", "started_at", "completed_at"]) assert.ok(item.required.includes(key));
});
