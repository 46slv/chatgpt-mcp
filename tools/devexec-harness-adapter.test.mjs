import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOuterReceipt, dedupeOuterCycle, runOuterCycles, verifyHarnessBinding } from "./devexec-harness-adapter.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-harness-adapter-")); return { root, file: path.join(root, "outer.json"), binding: { harness_repository: root, harness_commit_sha: SHA, target_repository: root, target_ref: "main", working_directory: root, evidence_root: path.join(root, "evidence") } }; }

test("outer adapter runs two bounded cycles with durable state handoff and role skipping", async () => {
  const f = fixture(); const calls = [];
  const launchCycle = async (r) => { calls.push(r); return { status: "DONE", evidence: { status: "DONE", fast_path_eligible: r.cycle_index === 1, skipped_roles: r.cycle_index === 1 ? ["manager-locate", "manager-plan"] : [], launched_roles: r.cycle_index === 1 ? ["worker", "verifier"] : ["manager-locate", "manager-plan", "worker", "verifier"], next_action: r.cycle_index === 0 ? "localized_retry" : "STOP" } }; };
  const out = await runOuterCycles({ receiptFile: f.file, outer_run_id: "outer-test", binding: f.binding, target_base_sha: SHA, working_directory: f.root, evidence_root: f.root, launchCycle });
  assert.equal(out.receipt.status, "COMPLETE"); assert.equal(calls.length, 2); assert.notEqual(calls[0].child_run_id, calls[1].child_run_id); assert.equal(out.receipt.cycles[0].resulting_state_hash, out.receipt.cycles[1].input_state_hash); assert.deepEqual(out.receipt.cycles[1].skipped_roles, ["manager-locate", "manager-plan"]); assert.equal(out.receipt.cycles[0].transcripts_forwarded, false); assert.equal(out.receipt.cycles[1].ephemeral, true);
});

test("restart resumes from durable receipt without replaying cycle A", async () => {
  const f = fixture(); let calls = []; const launchCycle = async (r) => { calls.push(r); return { status: "DONE", evidence: { next_action: "localized_retry", launched_roles: ["worker", "verifier"] } }; };
  await assert.rejects(() => runOuterCycles({ receiptFile: f.file, outer_run_id: "outer-restart", binding: f.binding, target_base_sha: SHA, working_directory: f.root, evidence_root: f.root, launchCycle, crashAfterCycle: 0 }), /SIMULATED_CRASH/);
  const resumed = await runOuterCycles({ receiptFile: f.file, outer_run_id: "outer-restart", binding: f.binding, target_base_sha: SHA, working_directory: f.root, evidence_root: f.root, launchCycle });
  assert.equal(calls.length, 2); assert.equal(resumed.receipt.cycles.length, 2); assert.equal(resumed.receipt.cycles[0].child_run_id, "outer-restart-cycle-0");
});

test("source drift stops before next child and dedupe is idempotent", async () => {
  const f = fixture(); const launchCycle = async () => ({ status: "DONE", evidence: { next_action: "localized_retry" } });
  let checks = 0; const out = await runOuterCycles({ receiptFile: f.file, outer_run_id: "outer-drift", binding: f.binding, target_base_sha: SHA, working_directory: f.root, evidence_root: f.root, launchCycle, sourceDriftCheck: () => checks++ >= 2 });
  assert.equal(out.receipt.cycles.length, 0); assert.equal(out.receipt.status, "NEEDS_HUMAN");
  const r = createOuterReceipt({ outer_run_id: "x", binding: f.binding }); r.cycles.push({ cycle_index: 1, input_state_hash: "a", harness_commit_sha: SHA }); assert.ok(dedupeOuterCycle(r, { cycle_index: 1, input_state_hash: "a", harness_commit_sha: SHA }));
});

test("binding requires full harness commit SHA", () => { const f = fixture(); assert.throws(() => verifyHarnessBinding({ ...f.binding, harness_commit_sha: "short" }), /full SHA/); });
