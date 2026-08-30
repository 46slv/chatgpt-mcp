import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalRunRecord, validateLocalRunRecord, writeLocalRunRecordAtomic, summarizeLocalRunRecords, contractFingerprint, createLifecycleRecorder } from "./local-run-ledger.mjs";
import { createTaskContract, runLocalWorkerTask } from "./local-worker-runtime.mjs";
import { runMinimalHarness } from "./minimal-harness-inference.mjs";
import { execFileSync } from "node:child_process";

const commit = "0123456789abcdef0123456789abcdef01234567";

function record(overrides = {}) {
  return createLocalRunRecord({
    run_id: "run-test-1",
    selection: { runtime: "local", provider: "freetoken", harness: "minimal-harness", model: "C:\\models\\qwen.gguf" },
    contract_fingerprint: commit,
    base_commit: commit,
    baseline: { clean: true, modified: 0, added: 0, deleted: 0, untracked: 0, digest: commit },
    lifecycle_ms: { preflight: 1, gpu_gate: 2, start: 3, ready: 4, inference: 5, test: 6, postflight: 7, cleanup: 8 },
    harness: { wall_time_ms: 100, first_tool_latency_ms: 10, tool_calls: 2, prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
    resources: { ram_mb: { before: 1, peak: 2, after: 1, available: true }, vram_mb: { before: null, peak: null, after: null, available: false } },
    outcome: { status: "DONE", changed: { count: 1, digest: commit }, diff: { count: 1, digest: commit }, tests: { status: "PASS", count: 1, digest: commit }, base_drift: false, commit_detected: false },
    evidence: { digest: commit }, ownership: { provider: "ADAPTER", cleanup: "COMPLETED", cleanup_verified: true },
    ...overrides,
  });
}

test("record schema is bounded and excludes prompts, paths, env and URLs", () => {
  const value = record();
  validateLocalRunRecord(value);
  const encoded = JSON.stringify(value);
  assert.match(encoded, /devexec\.local-run-record\/v1/);
  assert.doesNotMatch(encoded, /C:\\\\models|source_body|environment|https?:\/\//i);
  assert.equal(value.selection.model, "qwen.gguf");
  assert.equal(value.harness.total_tokens, 9);
  assert.equal(value.resources.vram_mb.available, false);
});

test("contract fingerprint is stable and omits goal, paths, cwd and repo", () => {
  const a = contractFingerprint({ version: 1, task_id: "x", repo: "C:/a", worktree: "C:/a", cwd: "C:/a", goal: "one", allowed_paths: ["a"], base_commit: commit, constraints: ["no commit"], test_command: ["node", "-e", "1"], timeout: 1000, max_tool_calls: 2, output_limit: 4000 });
  const b = contractFingerprint({ version: 1, task_id: "x", repo: "D:/different", worktree: "D:/different", cwd: "D:/different", goal: "two", allowed_paths: ["b"], base_commit: commit, constraints: ["no commit"], test_command: ["node", "-e", "1"], timeout: 1000, max_tool_calls: 2, output_limit: 4000 });
  assert.equal(a, b);
});

test("atomic writer creates one deterministic file and summary computes p50/p95", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-ledger-"));
  writeLocalRunRecordAtomic(dir, record());
  writeLocalRunRecordAtomic(dir, record({ run_id: "run-test-2", harness: { wall_time_ms: 300 } }));
  assert.deepEqual(fs.readdirSync(dir).sort(), ["run-test-1.json", "run-test-2.json"]);
  assert.deepEqual(summarizeLocalRunRecords(dir), { schema: "devexec.local-run-record/v1", count: 2, success: 2, success_rate: 1, wall_time_ms: { p50: 100, p95: 300 } });
  assert.throws(() => writeLocalRunRecordAtomic(dir, record()), /already exists/i);
});

test("lifecycle recorder reports durations and leaves unavailable phases absent", () => {
  let tick = 0;
  const rec = createLifecycleRecorder(() => ++tick);
  rec.mark("preflight_start"); rec.mark("preflight_end");
  assert.equal(rec.snapshot().preflight, 1);
  assert.equal(rec.snapshot().gpu_gate, undefined);
});

test("minimal harness propagates provider usage without inventing unavailable totals", async () => {
  const task = { goal: "bounded", repo: "repo", worktree: "worktree", allowed_paths: [], max_tool_calls: 1, timeout: 30000, output_limit: 1000 };
  const result = await runMinimalHarness(task, { infer: async () => ({ usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }, choices: [{ message: { content: "DONE" } }] }) });
  assert.equal(result.metrics.prompt_tokens, 11);
  assert.equal(result.metrics.completion_tokens, 7);
  assert.equal(result.metrics.total_tokens, 18);
  assert.equal(result.metrics.first_tool_latency_ms, null);
});

test("ledger writer failure is isolated from local worker result", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-ledger-runtime-"));
  fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
  execFileSync("git", ["-C", root, "init", "-q"]); execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]); execFileSync("git", ["-C", root, "config", "user.name", "ledger"]); execFileSync("git", ["-C", root, "add", "README.md"]); execFileSync("git", ["-C", root, "commit", "-q", "-m", "fixture"]);
  const base = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const task = createTaskContract({ task_id: "ledger-isolation", repo: root, worktree: root, base_commit: base, goal: "edit", allowed_paths: ["x.txt"], constraints: ["no commit"], test_command: [process.execPath, "-e", "process.stdout.write('ok')"], timeout: 30000, max_tool_calls: 2, output_limit: 1000 });
  const outcome = await runLocalWorkerTask(task, { runLedgerDir: root, ledgerWriter: () => { throw new Error("disk full"); }, adapter: { identity: { runtime: "local", provider: "fake" }, async run() { fs.writeFileSync(path.join(root, "x.txt"), "x\n"); return { status: "PASS" }; } } });
  assert.equal(outcome.result.status, "DONE");
  assert.equal(outcome.ledger.status, "FAILED");
});
