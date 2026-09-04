import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runOuterCycles } from "./devexec-harness-adapter.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA2 = "89abcdef0123456789abcdef0123456789abcdef";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-harness-pending-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const evidenceRoot = path.join(root, "evidence");
  const work = path.join(root, "work");
  fs.mkdirSync(evidenceRoot, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  return {
    root,
    file: path.join(root, "outer.json"),
    sideEffect: path.join(root, "side-effect.txt"),
    binding: {
      harness_repository: path.join(root, "harness"),
      harness_commit_sha: SHA,
      target_repository: path.join(root, "target"),
      target_ref: "automation/test-target",
      target_base_sha: SHA2,
      working_directory: work,
      evidence_root: evidenceRoot,
    },
  };
}

const common = (f, extra = {}) => ({
  receiptFile: f.file,
  outer_run_id: "outer-pending",
  binding: f.binding,
  goal_identity: "goal-1",
  task_identity: "task-1",
  project_adapter: "json",
  maxCycles: 1,
  ...extra,
});

test("durable pending intent exists before child invocation and clears only with accepted cycle", async (t) => {
  const f = fixture(t);
  let calls = 0;
  const out = await runOuterCycles(common(f, {
    launchCycle: async (request) => {
      calls += 1;
      const during = JSON.parse(fs.readFileSync(f.file, "utf8"));
      assert.equal(during.cycles.length, 0);
      assert.equal(during.status, "RUNNING");
      assert.equal(during.pending_cycle.cycle_index, 0);
      assert.equal(during.pending_cycle.child_run_id, request.child_run_id);
      assert.equal(during.pending_cycle.input_state_hash, request.expected_previous_state_hash);
      assert.equal(during.pending_cycle.harness_commit_sha, f.binding.harness_commit_sha);
      assert.equal(during.pending_cycle.target_base_sha, f.binding.target_base_sha);
      assert.equal(during.pending_cycle.target_ref, f.binding.target_ref);
      return {
        status: "DONE",
        evidence: {
          second_cycle: "NOT_RUN",
          input_state_hash: request.expected_previous_state_hash,
          resulting_state_hash: "a".repeat(64),
          next_action: "STOP",
        },
      };
    },
  }));
  assert.equal(calls, 1);
  assert.equal(out.receipt.pending_cycle, null);
  assert.equal(out.receipt.cycles.length, 1);
  assert.equal(out.receipt.cycles[0].child_run_id, "outer-pending-cycle-0");
  assert.equal(out.receipt.status, "COMPLETE");
});

test("side effect before accepted-cycle receipt becomes ambiguous and restart never blindly relaunches", async (t) => {
  const f = fixture(t);
  let calls = 0;
  await assert.rejects(
    () => runOuterCycles(common(f, {
      launchCycle: async () => {
        calls += 1;
        fs.writeFileSync(f.sideEffect, `mutation-${calls}`, "utf8");
        throw new Error("SIMULATED_PARENT_LOSS_AFTER_CHILD_SIDE_EFFECT");
      },
    })),
    /SIMULATED_PARENT_LOSS_AFTER_CHILD_SIDE_EFFECT/,
  );
  assert.equal(calls, 1);
  const afterLoss = JSON.parse(fs.readFileSync(f.file, "utf8"));
  assert.equal(afterLoss.cycles.length, 0);
  assert.equal(afterLoss.status, "RUNNING");
  assert.equal(afterLoss.pending_cycle.child_run_id, "outer-pending-cycle-0");
  assert.equal(fs.readFileSync(f.sideEffect, "utf8"), "mutation-1");

  const resumed = await runOuterCycles(common(f, {
    launchCycle: async () => {
      calls += 1;
      fs.writeFileSync(f.sideEffect, `mutation-${calls}`, "utf8");
      return { status: "DONE", evidence: { next_action: "STOP" } };
    },
  }));
  assert.equal(calls, 1);
  assert.equal(resumed.decision.action, "STOP");
  assert.equal(resumed.decision.reason, "AMBIGUOUS_IN_FLIGHT_CHILD");
  assert.equal(resumed.receipt.status, "NEEDS_HUMAN");
  assert.equal(resumed.receipt.cycles.length, 0);
  assert.equal(resumed.receipt.pending_cycle.child_run_id, "outer-pending-cycle-0");
  assert.equal(fs.readFileSync(f.sideEffect, "utf8"), "mutation-1");

  const secondRestart = await runOuterCycles(common(f, {
    launchCycle: async () => { calls += 1; return {}; },
  }));
  assert.equal(calls, 1);
  assert.equal(secondRestart.decision.reason, "AMBIGUOUS_IN_FLIGHT_CHILD");
  assert.equal(secondRestart.receipt.status, "NEEDS_HUMAN");
});
