import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createLocalRunRecord, validateLocalRunRecord, writeLocalRunRecordAtomic, attributeGitEvidence } from "./local-run-ledger.mjs";
import { createTaskContract, runLocalWorkerTask, captureGitEvidence } from "./local-worker-runtime.mjs";
import { runMinimalHarness } from "./minimal-harness-inference.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-observability-hardening-"));
  fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
  execFileSync("git", ["-C", root, "init", "-q"]); execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]); execFileSync("git", ["-C", root, "config", "user.name", "DevExec"]); execFileSync("git", ["-C", root, "add", "README.md"]); execFileSync("git", ["-C", root, "commit", "-q", "-m", "fixture"]);
  const base = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return { root, task: createTaskContract({ task_id: "observability-hardening", repo: root, worktree: root, cwd: root, base_commit: base, goal: "bounded edit", allowed_paths: ["allowed.txt", "dirty.txt"], constraints: ["no commit"], test_command: [process.execPath, "-e", "process.exit(0)"], timeout: 30000, max_tool_calls: 2, output_limit: 2000 }) };
}
const passAdapter = (fn = async () => {}) => ({ identity: { runtime: "local", provider: "fake" }, async run(task) { await fn(task); return { status: "PASS", metrics: { wall_time_ms: 999999, first_tool: "https://bad.example/?token=x", prompt_tokens: 4 } }; } });

test("pre-dirty no-op cannot claim DONE", async () => { const f = fixture(); fs.writeFileSync(path.join(f.root, "dirty.txt"), "before\n"); const result = await runLocalWorkerTask(f.task, { adapter: passAdapter() }); assert.equal(result.result.status, "FAILED"); assert.deepEqual(result.result.changed_files, []); });
test("pre-dirty unchanged path is excluded while a new allowed edit is attributed", async () => { const f = fixture(); fs.writeFileSync(path.join(f.root, "dirty.txt"), "before\n"); const result = await runLocalWorkerTask(f.task, { adapter: passAdapter(async (task) => fs.writeFileSync(path.join(task.worktree, "allowed.txt"), "new\n")) }); assert.equal(result.result.status, "DONE"); assert.deepEqual(result.result.changed_files, ["allowed.txt"]); });
test("a pre-dirty path modified during the run is attributed", async () => { const f = fixture(); fs.writeFileSync(path.join(f.root, "dirty.txt"), "before\n"); const result = await runLocalWorkerTask(f.task, { adapter: passAdapter(async (task) => fs.writeFileSync(path.join(task.worktree, "dirty.txt"), "after\n")) }); assert.equal(result.result.status, "DONE"); assert.deepEqual(result.result.changed_files, ["dirty.txt"]); });
test("new or modified unexpected paths block even when provider says PASS", async () => { const f = fixture(); const result = await runLocalWorkerTask(f.task, { adapter: passAdapter(async (task) => fs.writeFileSync(path.join(task.worktree, "outside.txt"), "bad\n")) }); assert.equal(result.result.status, "BLOCKED"); assert.match(result.result.blocker, /unexpected changed paths/); });
test("attribution changes only on status or fingerprint mutation", () => { const before = { path_details: { "x.txt": { status: " M", fingerprint: SHA, fingerprint_bounded: true } } }; const same = { path_details: { "x.txt": { status: " M", fingerprint: SHA, fingerprint_bounded: true } } }; const changed = { path_details: { "x.txt": { status: " M", fingerprint: SHA.replace(/^0/, "1"), fingerprint_bounded: true } } }; assert.deepEqual(attributeGitEvidence(before, same).paths, []); assert.deepEqual(attributeGitEvidence(before, changed).paths, ["x.txt"]); });

test("ledger validation is recursively exact and fail-closed", () => { const record = createLocalRunRecord({ run_id: "safe-run", contract_fingerprint: SHA, base_commit: SHA }); validateLocalRunRecord(record); for (const mutate of [(r) => { r.harness.provider_usage.extra = 1; }, (r) => { r.selection.provider = "https://bad"; }, (r) => { r.base_commit = SHA.toUpperCase(); }, (r) => { r.outcome.tests = []; }]) { const copy = structuredClone(record); mutate(copy); assert.throws(() => validateLocalRunRecord(copy)); } });
test("model path is reduced to a safe basename and query is removed", () => { const record = createLocalRunRecord({ run_id: "safe-run", selection: { runtime: "local", provider: "freetoken", harness: "minimal-harness", model: "C:\\models\\qwen.gguf?token=secret#x" }, contract_fingerprint: SHA, base_commit: SHA }); assert.equal(record.selection.model, "qwen.gguf"); assert.doesNotMatch(record.selection.model, /https?:|token=|[\\/]/i); });
test("atomic writer is no-overwrite under same-run concurrency", async () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-ledger-concurrency-")); const record = createLocalRunRecord({ run_id: "same-run", contract_fingerprint: SHA, base_commit: SHA }); const outcomes = await Promise.all(Array.from({ length: 20 }, () => Promise.resolve().then(() => { try { return writeLocalRunRecordAtomic(dir, record), "ok"; } catch { return "failed"; } }))); assert.equal(outcomes.filter((x) => x === "ok").length, 1); assert.deepEqual(fs.readdirSync(dir), ["same-run.json"]); });
test("atomic writer removes its owned temp on write/link/unlink failures", () => {
  const cases = [
    { name: "write", mutate: (base) => ({ ...base, writeSync(fd, ...args) { throw new Error("simulated write"); } }) },
    { name: "link", mutate: (base) => ({ ...base, linkSync() { throw new Error("simulated link"); } }) },
    { name: "unlink", mutate: (base) => { let first = true; return { ...base, unlinkSync(file) { if (String(file).includes(".tmp-") && first) { first = false; throw new Error("simulated unlink"); } return fs.unlinkSync(file); } }; } },
  ];
  for (const item of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `devexec-ledger-${item.name}-`));
    const record = createLocalRunRecord({ run_id: `failure-${item.name}`, contract_fingerprint: SHA, base_commit: SHA });
    assert.throws(() => writeLocalRunRecordAtomic(dir, record, { fsImpl: item.mutate(fs) }), /simulated/);
    assert.equal(fs.readdirSync(dir).some((name) => name.includes(".tmp-")), false, `${item.name} failure left a temp file`);
  }
});

test("canonical path and availability aliases fail closed", () => {
  for (const value of ["a//b.txt", "a\\\\b.txt", "a/./b.txt", "a/%2e/b.txt", "a/\u0001b.txt"]) {
    assert.throws(() => createTaskContract({ task_id: "bad-path", repo: ".", base_commit: SHA, goal: "x", allowed_paths: [value], test_command: [process.execPath, "-e", "0"], timeout: 1000, max_tool_calls: 1, output_limit: 256 }));
  }
  const record = createLocalRunRecord({ run_id: "availability-alias", contract_fingerprint: SHA, base_commit: SHA, resources: { ram_mb: { availability: "AVAILABLE" }, vram_mb: { availability: "NOT_COLLECTED" } } });
  assert.equal(record.resources.ram_mb.available, true);
  assert.equal(record.resources.vram_mb.available, null);
  assert.throws(() => createLocalRunRecord({ run_id: "availability-invalid", contract_fingerprint: SHA, base_commit: SHA, resources: { ram_mb: { availability: "legacy" }, vram_mb: {} } }));
});

test("hard-linked worktree files are rejected before harness read/write and attribution", async (t) => {
  const f = fixture();
  const external = path.join(os.tmpdir(), `devexec-external-${process.pid}-${Date.now()}.txt`);
  const inside = path.join(f.root, "src", "value.txt");
  fs.mkdirSync(path.dirname(inside), { recursive: true });
  fs.writeFileSync(external, "external-secret\n");
  try { fs.linkSync(external, inside); } catch (error) { t.skip(`hard links unavailable: ${error.code || error.message}`); return; }
  try {
    assert.equal(fs.lstatSync(inside).nlink > 1, true);
    const read = await runMinimalHarness({ ...f.task, allowed_paths: ["src/value.txt"] }, { infer: async () => ({ choices: [{ message: { tool_calls: [{ function: { name: "read", arguments: JSON.stringify({ path: "src/value.txt" }) } }] } }] }), maxToolCalls: 1 });
    assert.notEqual(read.status, "PASS");
    assert.doesNotMatch(JSON.stringify(read), /external-secret/);
    const patch = await runMinimalHarness({ ...f.task, allowed_paths: ["src/value.txt"] }, { infer: async () => ({ choices: [{ message: { tool_calls: [{ function: { name: "apply_patch", arguments: JSON.stringify({ path: "src/value.txt", content: "worker-must-not-write\\n" }) } }] } }] }), maxToolCalls: 1 });
    assert.notEqual(patch.status, "PASS");
    const beforeEvidence = captureGitEvidence(f.root);
    assert.equal(beforeEvidence.invalid_paths, true);
    assert.deepEqual(beforeEvidence.hard_link_paths, ["src/value.txt"]);
    const outcome = await runLocalWorkerTask({ ...f.task, allowed_paths: ["src/value.txt"] }, { adapter: passAdapter(async () => { fs.writeFileSync(inside, "mutated\n"); }) });
    assert.equal(outcome.result.status, "BLOCKED");
    assert.match(outcome.result.blocker, /hard-linked|PATH_HARDLINK|preflight/i);
    assert.equal(fs.readFileSync(external, "utf8"), "external-secret\n");
  } finally {
    try { fs.unlinkSync(inside); } catch {}
    try { fs.unlinkSync(external); } catch {}
  }
});
test("adapter-created junction is recursively inspected and cannot claim success", async (t) => {
  const f = fixture();
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-junction-external-"));
  const junction = path.join(f.root, "src", "j");
  fs.mkdirSync(path.dirname(junction), { recursive: true });
  try {
    try { fs.symlinkSync(external, junction, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) { t.skip(`junction creation is unavailable: ${error.code || error.message}`); return; }
    const outcome = await runLocalWorkerTask({ ...f.task, allowed_paths: ["src"] }, { adapter: passAdapter(async () => { fs.writeFileSync(path.join(junction, "x.txt"), "external-write\n"); }) });
    assert.notEqual(outcome.result.status, "DONE");
    assert.equal(outcome.result.safety_metrics.invalid_paths, true);
    assert.ok(outcome.result.safety_metrics.reparse_paths.includes("src/j") || outcome.result.safety_metrics.invalid_path_list.some((p) => p.startsWith("src/j")));
    assert.doesNotMatch(JSON.stringify(outcome.result), /external-write/);
    assert.equal(fs.readFileSync(path.join(external, "x.txt"), "utf8"), "external-write\n");
  } finally {
    try { fs.unlinkSync(junction); } catch {}
    try { fs.rmSync(external, { recursive: true, force: true }); } catch {}
  }
});
test("metric provenance keeps worker observations out of parent_measured", async () => { const f = fixture(); const result = await runLocalWorkerTask(f.task, { adapter: passAdapter(async (task) => fs.writeFileSync(path.join(task.worktree, "allowed.txt"), "ok\n")), runLedgerDir: f.root }); assert.notEqual(result.result.runtime_metrics.wall_time_ms, 999999); const ledger = JSON.parse(fs.readFileSync(path.join(f.root, `${result.run_id}.json`), "utf8")); assert.notEqual(ledger.harness.parent_measured.wall_time_ms, 999999); assert.equal(ledger.harness.parent_measured.first_tool, null); assert.equal(ledger.harness.parent_measured.source, "parent_measured"); assert.equal(ledger.harness.harness_reported.wall_time_ms, 999999); assert.equal(ledger.harness.harness_reported.source, "harness_reported"); assert.equal(ledger.harness.adapter_reported.first_tool, "https___bad.example__token_x"); assert.equal(ledger.harness.adapter_reported.source, "adapter_reported"); });

test("parent resource measurements survive provider failure and identity paths stay private", async () => {
  const f = fixture();
  const sampler = { start() {}, stop() { return { ram_mb: { before: 100, peak: 120, after: 110, availability: "AVAILABLE", available: true }, vram_mb: { before: 10, peak: 20, after: 12, availability: "AVAILABLE", available: true }, gpu_utilization_pct: { before: 1, peak: 40, after: 2, availability: "AVAILABLE", available: true } }; } };
  const adapter = { identity: { runtime: "local", provider: "fake", model: "C:\\private\\qwen.gguf?token=secret#x", repo_path: "C:\\private\\source" }, async run() { return { status: "FAILED", code: "INFERENCE_REQUEST_TIMEOUT", metrics: { ram_before_mb: 999999 } }; } };
  const outcome = await runLocalWorkerTask(f.task, { adapter, runLedgerDir: f.root, resourceSampler: sampler });
  assert.equal(outcome.result.status, "FAILED");
  assert.equal(outcome.result.runtime_provider_identity.model, "qwen.gguf");
  assert.deepEqual(outcome.result.resources.ram_mb, { before: 100, peak: 120, after: 110, availability: "AVAILABLE", available: true });
  assert.match(outcome.result.blocker, /INFERENCE_REQUEST_TIMEOUT/);
  const encoded = JSON.stringify(outcome);
  assert.doesNotMatch(encoded, /C:\\private|token=secret/);
  const ledger = JSON.parse(fs.readFileSync(path.join(f.root, `${outcome.run_id}.json`), "utf8"));
  assert.deepEqual(ledger.resources.gpu_utilization_pct, { before: 1, peak: 40, after: 2, availability: "AVAILABLE", available: true });
  assert.equal(ledger.selection.model, "qwen.gguf");
  assert.doesNotMatch(JSON.stringify(ledger), /C:\\private|token=secret/);
});
