import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createTaskContract, runTestCommand } from "./local-worker-runtime.mjs";
import { runMinimalHarness } from "./minimal-harness-inference.mjs";
import { createFreeTokenInferenceAdapter } from "./freetoken-inference-adapter.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-minimal-harness-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
  fs.writeFileSync(path.join(root, "src", "value.txt"), "1\n");
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Minimal Harness Test"]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "fixture"]);
  const base = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const task = createTaskContract({ task_id: "harness-fixture", repo: root, worktree: root, base_commit: base, goal: "change value to two", allowed_paths: ["src/value.txt"], constraints: ["do not commit"], test_command: [process.execPath, "-e", "process.exit(require('fs').readFileSync('src/value.txt','utf8').trim()==='2'?0:1)"], timeout: 30000, max_tool_calls: 6, output_limit: 4000 });
  return { root, task };
}

function response(...calls) {
  return { choices: [{ message: { role: "assistant", tool_calls: calls.map((c, i) => ({ id: `call-${i + 1}`, type: "function", function: { name: c[0], arguments: JSON.stringify(c[1] || {}) } })) } }] };
}

test("fixture A: model patch, regression test, and diff through the generic loop", async () => {
  const f = fixture();
  const queue = [
    response(["patch", { path: "src/value.txt", content: "2\n" }]),
    response(["run_test", {}], ["git_diff", { path: "src/value.txt" }]),
    { choices: [{ message: { role: "assistant", content: "DONE" } }] },
  ];
  const result = await runMinimalHarness(f.task, { infer: async () => queue.shift(), runTest: runTestCommand });
  assert.equal(result.status, "PASS");
  assert.equal(result.tool_calls, 3);
  assert.equal(fs.readFileSync(path.join(f.root, "src/value.txt"), "utf8"), "2\n");
  assert.equal(result.observations.some((x) => x.name === "run_test" && x.ok), true);
  assert.equal(result.observations.some((x) => x.name === "git_diff" && x.ok), true);
});

test("new allowed untracked file has bounded no-index diff evidence and completes", async () => {
  const f = fixture();
  const task = createTaskContract({ ...f.task, task_id: "untracked-diff", goal: "create answer", allowed_paths: ["answer.txt"], test_command: [process.execPath, "-e", "process.exit(require('fs').readFileSync('answer.txt','utf8')==='ok\\n'?0:1)"] });
  const queue = [
    response(["patch", { path: "answer.txt", content: "ok\n" }]),
    response(["run_test", {}], ["git_diff", { path: "answer.txt" }]),
  ];
  const result = await runMinimalHarness(task, { infer: async () => queue.shift(), runTest: runTestCommand, maxToolCalls: 3 });
  const diff = result.observations.find((entry) => entry.name === "git_diff");
  assert.equal(result.status, "PASS");
  assert.equal(diff?.ok, true);
  assert.match(diff.diff.diff, /answer\.txt/);
  assert.match(diff.diff.diff, /\+ok/);
});

test("git_diff denies outside or sensitive paths and refuses truncated untracked evidence", async () => {
  const f = fixture();
  const outside = await runMinimalHarness(f.task, { infer: async () => response(["git_diff", { path: "README.md" }]) });
  assert.equal(outside.status, "BLOCKED"); assert.equal(outside.code, "SCOPE_VIOLATION");
  const sensitive = await runMinimalHarness(f.task, { infer: async () => response(["git_diff", { path: ".env" }]) });
  assert.equal(sensitive.observations.length, 1); assert.equal(sensitive.observations[0].ok, false);
  const task = createTaskContract({ ...f.task, task_id: "untracked-truncated", allowed_paths: ["answer.txt"], test_command: [process.execPath, "-e", "process.exit(0)"] });
  const queue = [response(["patch", { path: "answer.txt", content: "x".repeat(2000) }]), response(["run_test", {}], ["git_diff", { path: "answer.txt", max_chars: 40 }])];
  const truncated = await runMinimalHarness(task, { infer: async () => queue.shift(), runTest: runTestCommand, maxToolCalls: 3 });
  assert.equal(truncated.status, "PARTIAL");
  assert.equal(truncated.observations.find((entry) => entry.name === "git_diff")?.ok, false);
});

test("benchmark-compatible apply_patch old/new arguments are accepted", async () => {
  const f = fixture();
  const queue = [
    response(["apply_patch", { path: "src/value.txt", old: "1\n", new: "2\n" }]),
    response(["run_test", {}], ["git_diff", { path: "src/value.txt" }]),
    { choices: [{ message: { role: "assistant", content: "DONE" } }] },
  ];
  const result = await runMinimalHarness(f.task, { infer: async () => queue.shift(), runTest: runTestCommand });
  assert.equal(result.status, "PASS");
  assert.equal(result.tool_calls, 3);
  assert.equal(fs.readFileSync(path.join(f.root, "src", "value.txt"), "utf8"), "2\n");
  assert.equal(result.observations.some((x) => x.name === "apply_patch" && x.ok), true);
});

test("apply_patch search/replace aliases remain exact and reject ambiguous preimages", async () => {
  const f = fixture();
  const queue = [
    response(["apply_patch", { path: "src/value.txt", search: "1\n", replace: "2\n" }]),
    { choices: [{ message: { role: "assistant", content: "DONE" } }] },
  ];
  const success = await runMinimalHarness(f.task, { infer: async () => queue.shift() });
  assert.equal(success.status, "PASS");
  assert.equal(fs.readFileSync(path.join(f.root, "src", "value.txt"), "utf8"), "2\n");

  fs.writeFileSync(path.join(f.root, "src", "value.txt"), "1\n1\n");
  const repeated = [
    response(["apply_patch", { path: "src/value.txt", old: "1\n", new: "2\n" }]),
    response(["apply_patch", { path: "src/value.txt", old: "1\n", new: "2\n" }]),
  ];
  const blocked = await runMinimalHarness(f.task, { infer: async () => repeated.shift(), maxToolCalls: 4 });
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.code, "DUPLICATE_FAILURE");
  assert.equal(fs.readFileSync(path.join(f.root, "src", "value.txt"), "utf8"), "1\n1\n");
});

test("apply_patch keeps scope and targeted-size guards for compatibility aliases", async () => {
  const f = fixture();
  const outside = await runMinimalHarness(f.task, { infer: async () => response(["apply_patch", { path: "README.md", old: "fixture\n", new: "outside\n" }]) });
  assert.equal(outside.status, "BLOCKED");
  assert.equal(outside.code, "SCOPE_VIOLATION");
  const oversized = await runMinimalHarness(f.task, { infer: async () => response(["apply_patch", { path: "src/value.txt", old: "x".repeat(1801), new: "2" }]) });
  assert.notEqual(oversized.status, "PASS");
  assert.equal(fs.readFileSync(path.join(f.root, "src", "value.txt"), "utf8"), "1\n");
});

test("fixture B: a patch outside allowed_paths is rejected before writing", async () => {
  const f = fixture();
  const result = await runMinimalHarness(f.task, { infer: async () => response(["patch", { path: "README.md", content: "outside\n" }]) });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.code, "SCOPE_VIOLATION");
  assert.equal(fs.readFileSync(path.join(f.root, "README.md"), "utf8"), "fixture\n");
});

test("fixture C: unavailable, timeout, and worker crash remain bounded failures", async () => {
  const f = fixture();
  const unavailable = await runMinimalHarness(f.task, { infer: async () => ({ choices: [] }) });
  assert.equal(unavailable.status, "FAILED");
  assert.equal(unavailable.code, "MALFORMED_RESULT");
  const controller = new AbortController();
  controller.abort(new Error("timeout"));
  const timeout = await runMinimalHarness(f.task, { infer: async () => ({ choices: [] }), signal: controller.signal });
  assert.equal(timeout.status, "CANCELLED");
  const crash = await runMinimalHarness(f.task, {
    infer: async () => response(["run_test", {}]),
    runTest: async () => { throw new Error("worker crashed"); },
    maxToolCalls: 3,
  });
  assert.equal(crash.status, "BLOCKED");
  assert.equal(crash.code, "DUPLICATE_FAILURE");
});

test("FreeToken adapter wires the OpenAI-compatible response into the same harness", async () => {
  const f = fixture();
  const calls = [];
  const queue = [
    { body: { status: "ok", engineRunning: false } },
    new Error("ECONNREFUSED"),
    { body: { accepted: true } },
    { body: { status: "ok", model: "qwen" } },
    { body: response(["patch", { path: "src/value.txt", content: "2\n" }]) },
    { body: { choices: [{ message: { role: "assistant", content: "DONE" } }] } },
    { body: { stopped: true } },
  ];
  const adapter = createFreeTokenInferenceAdapter({ config: { enabled: true, model: "qwen", readyTimeoutMs: 1000 }, gpuProbe: () => ({ status: "CLEAR" }), sleep: async () => {}, request: async (url, options) => { calls.push({ url, options }); const next = queue.shift(); if (next instanceof Error) throw next; return next; } });
  const result = await adapter.run(f.task);
  assert.equal(result.status, "PASS");
  assert.equal(result.tool_calls, 1);
  assert.equal(JSON.parse(calls.find((x) => x.url.includes("chat/completions")).options.body).tools.length, 5);
  assert.equal(fs.readFileSync(path.join(f.root, "src", "value.txt"), "utf8"), "2\n");
});

test("verified-evidence fallback stays cancelled when abort happens during delayed final run_test", async () => {
  const f = fixture();
  const controller = new AbortController();
  const queue = [response(["patch", { path: "src/value.txt", content: "2\n" }]), response(["run_test", {}], ["git_diff", { path: "src/value.txt" }])];
  const result = await runMinimalHarness(f.task, {
    infer: async () => queue.shift(),
    signal: controller.signal,
    maxToolCalls: 3,
    runTest: async () => { await new Promise((resolve) => setTimeout(resolve, 10)); controller.abort(new Error("cancelled")); return { status: "PASS" }; },
  });
  assert.equal(result.status, "CANCELLED");
  assert.equal(result.code, "CANCELLED");
  assert.match(result.reason, /cancelled/i);
});

test("verified-evidence fallback distinguishes a harness deadline from max tool calls", async () => {
  const f = fixture();
  let calls = 0;
  const result = await runMinimalHarness(f.task, {
    infer: async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 1100)); return response(["patch", { path: "src/value.txt", content: "2\n" }]); },
    timeoutMs: 1000,
    maxToolCalls: 1,
  });
  assert.equal(calls, 1);
  assert.notEqual(result.status, "PASS");
  assert.equal(result.code, "HARNESS_TIMEOUT");
  assert.match(result.reason, /deadline exceeded/i);
});

test("verified-evidence fallback rejects an empty diff even with a passing test", async () => {
  const f = fixture();
  const queue = [response(["patch", { path: "src/value.txt", content: "1\n" }]), response(["run_test", {}], ["git_diff", { path: "src/value.txt" }])];
  const result = await runMinimalHarness(f.task, { infer: async () => queue.shift(), runTest: runTestCommand, maxToolCalls: 3 });
  assert.equal(result.status, "PARTIAL");
  assert.equal(result.code, "HARNESS_MAX_TOOL_CALLS");
  assert.equal(result.observations.some((x) => x.name === "git_diff" && x.ok), false);
});

test("verified-evidence fallback rejects a fake PASS test result", async () => {
  const f = fixture();
  const queue = [response(["patch", { path: "src/value.txt", content: "2\n" }]), response(["run_test", {}], ["git_diff", { path: "src/value.txt" }])];
  const result = await runMinimalHarness(f.task, { infer: async () => queue.shift(), runTest: async () => ({ status: "PASS" }), maxToolCalls: 3 });
  assert.equal(result.status, "PARTIAL");
  assert.equal(result.code, "HARNESS_MAX_TOOL_CALLS");
  assert.equal(result.observations.some((x) => x.name === "run_test" && x.ok), false);
});

test("verified-evidence fallback accepts only nonempty diff plus parent test evidence", async () => {
  const f = fixture();
  const queue = [response(["patch", { path: "src/value.txt", content: "2\n" }]), response(["run_test", {}], ["git_diff", { path: "src/value.txt" }])];
  const result = await runMinimalHarness(f.task, { infer: async () => queue.shift(), runTest: runTestCommand, maxToolCalls: 3 });
  assert.equal(result.status, "PASS");
  assert.match(result.summary, /parent-verified evidence/i);
});
