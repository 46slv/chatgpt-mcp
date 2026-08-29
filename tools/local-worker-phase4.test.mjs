import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  captureGitEvidence,
  createFailureFingerprintGuard,
  createTaskContract,
  runLocalWorkerTask,
  runTestCommand,
} from "./local-worker-runtime.mjs";
import { createFreeTokenInferenceAdapter, createFreeTokenConfig, FREETOKEN_FAILURES } from "./freetoken-inference-adapter.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-phase4-"));
  fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Phase4 Test"]);
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "fixture"]);
  const base = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return { root, base, task: createTaskContract({ task_id: "phase4-fixture", repo: root, worktree: root, base_commit: base, goal: "bounded fixture", allowed_paths: ["src/value.txt"], constraints: ["no commit"], test_command: [process.execPath, "-e", "process.stdout.write('ok')"], timeout: 30000, max_tool_calls: 4, output_limit: 256 }) };
}

test("test command cancellation kills the owned process tree and is explicit", async () => {
  const f = fixture();
  const child = new EventEmitter(); child.pid = 19; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  let killed = 0;
  const controller = new AbortController();
  const pending = runTestCommand(f.task, { spawnImpl: () => child, killTree: () => { killed += 1; queueMicrotask(() => child.emit("close", null, "SIGTERM")); return true; }, signal: controller.signal });
  controller.abort(new Error("cancelled"));
  const result = await pending;
  assert.equal(result.status, "CANCELLED"); assert.equal(result.cancelled, true); assert.equal(killed, 1);
});

test("parent aborts repeated identical worker crashes after the second fingerprint", async () => {
  const f = fixture(); const guard = createFailureFingerprintGuard();
  const adapter = { identity: { runtime: "local", provider: "fake" }, async run() { throw new Error("worker crashed token=secret"); } };
  const first = await runLocalWorkerTask(f.task, { adapter, failureGuard: guard });
  const second = await runLocalWorkerTask(f.task, { adapter, failureGuard: guard });
  assert.equal(first.result.status, "FAILED"); assert.equal(second.result.status, "BLOCKED");
  assert.match(second.result.blocker, /duplicate failure fingerprint/i);
  assert.doesNotMatch(first.result.blocker, /secret/); assert.match(first.log.blocker, /REDACTED/);
});

test("changed-file evidence is bounded and marked truncated rather than trusted", () => {
  const f = fixture();
  for (let i = 0; i < 3; i += 1) fs.writeFileSync(path.join(f.root, `untracked-${i}.txt`), "x");
  const evidence = captureGitEvidence(f.root, { maxPaths: 2 });
  assert.equal(evidence.paths_truncated, true); assert.equal(evidence.changed_path_count, 3); assert.equal(evidence.changed_paths.length, 2);
});

test("FreeToken config is loopback-only and malformed provider bodies fail closed", async () => {
  assert.throws(() => createFreeTokenConfig({ enabled: true, model: "m", controlUrl: "https://example.invalid" }), /loopback/i);
  const adapter = createFreeTokenInferenceAdapter({ config: { enabled: true, model: "m" }, gpuProbe: () => ({ status: "CLEAR" }), sleep: async () => {}, request: async (url) => {
    if (url.endsWith("/health")) return { body: { status: "ok", engineRunning: true } };
    return { body: null };
  } });
  const result = await adapter.run({ goal: "hello" });
  assert.equal(result.status, "FAILED"); assert.equal(result.code, FREETOKEN_FAILURES.MALFORMED_RESULT);
});

test("structured execution evidence redacts source bodies and keeps local provider identity", async () => {
  const f = fixture();
  const outcome = await runLocalWorkerTask(f.task, { adapter: { identity: { runtime: "local", provider: "fake" }, async run() { return { status: "FAILED", source_body: "password=secret" }; } } });
  assert.equal(outcome.result.status, "FAILED");
  assert.equal(outcome.log.runtime_provider_identity.provider, "fake");
  assert.doesNotMatch(JSON.stringify(outcome.log), /password=secret|source_body/);
});
