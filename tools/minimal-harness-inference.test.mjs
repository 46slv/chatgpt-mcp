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
