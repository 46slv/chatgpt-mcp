import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  createDevExecEntrypoint,
  resolveDevExecRuntimeSelection,
  DEVEXEC_RUNTIME,
  DEVEXEC_PROVIDER,
} from "./devexec-runtime-selector.mjs";
import { createTaskContract } from "./local-worker-runtime.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-selector-"));
  fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "DevExec Test"]);
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "fixture"]);
  const base = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return createTaskContract({ task_id: "selector-fixture", repo: root, worktree: root, base_commit: base, goal: "bounded local edit", allowed_paths: ["src/value.txt"], constraints: ["no commit"], test_command: [process.execPath, "-e", "process.exit(0)"], timeout: 30000, max_tool_calls: 4, output_limit: 4000 });
}

test("default and disabled selection retain the existing adapter path", async () => {
  const existing = { async run(value) { return { path: value }; } };
  const defaultEntry = createDevExecEntrypoint({ adapters: { default: existing } });
  assert.deepEqual(defaultEntry.selection, { runtime: DEVEXEC_RUNTIME.DEFAULT, provider: DEVEXEC_PROVIDER.EXISTING, explicit: false, enabled: false });
  assert.deepEqual(await defaultEntry.run("cloud"), { path: "cloud" });
  const disabled = createDevExecEntrypoint({ selection: { runtime: "local", provider: "freetoken", enabled: false }, adapters: { default: existing, freetoken: { async run() { throw new Error("must not route"); } } } });
  assert.equal(disabled.selection.runtime, "default");
  assert.deepEqual(await disabled.run("existing"), { path: "existing" });
});

test("explicit local FreeToken selection uses only the supplied adapter", async () => {
  const task = fixture();
  const provider = { identity: { runtime: "local", provider: "freetoken" }, async run() { fs.mkdirSync(path.join(task.worktree, "src")); fs.writeFileSync(path.join(task.worktree, "src/value.txt"), "ok\n"); return { status: "PASS" }; } };
  const entry = createDevExecEntrypoint({ selection: { runtime: "local", provider: "freetoken", enabled: true }, adapters: { freetoken: provider } });
  const outcome = await entry.run(task, { runTest: async () => ({ status: "PASS" }) });
  assert.equal(outcome.result.status, "DONE");
  assert.equal(outcome.result.runtime_provider_identity.provider, "freetoken");
});

test("unsupported runtime/provider choices fail closed without routing", () => {
  assert.throws(() => resolveDevExecRuntimeSelection({ runtime: "remote", provider: "freetoken", enabled: true }), /unsupported runtime/i);
  assert.throws(() => resolveDevExecRuntimeSelection({ runtime: "local", provider: "unknown", enabled: true }), /provider/i);
  assert.equal(createDevExecEntrypoint({ selection: { runtime: "local", provider: "freetoken", enabled: true } }).identity.provider, "freetoken");
});

test("unsuitable classifications and malformed contracts are rejected before provider invocation", async () => {
  const base = fixture();
  assert.throws(() => createTaskContract({ ...base, classification: "architecture" }), /not suitable/i);
  const provider = { async run() { throw new Error("must not run"); } };
  const entry = createDevExecEntrypoint({ selection: { runtime: "local", provider: "freetoken", enabled: true }, adapters: { freetoken: provider } });
  await assert.rejects(() => entry.run({ ...base, goal: "" }), /goal/i);
});

test("provider BLOCKED result is preserved as a parent-reverified BLOCKED outcome", async () => {
  const task = fixture();
  const entry = createDevExecEntrypoint({ selection: { runtime: "local", provider: "freetoken", enabled: true }, adapters: { freetoken: { identity: { runtime: "local", provider: "freetoken" }, async run() { return { status: "BLOCKED", code: "UNAVAILABLE" }; } } } });
  const outcome = await entry.run(task, { runTest: async () => ({ status: "PASS" }) });
  assert.equal(outcome.result.status, "BLOCKED");
  assert.match(outcome.result.blocker, /provider blocked/i);
});

test("malformed provider response is fail-closed", async () => {
  const task = fixture();
  const entry = createDevExecEntrypoint({ selection: { runtime: "local", provider: "freetoken", enabled: true }, adapters: { freetoken: { async run() { return { nope: true }; } } } });
  const outcome = await entry.run(task, { runTest: async () => ({ status: "PASS" }) });
  assert.equal(outcome.result.status, "FAILED");
  assert.match(outcome.result.blocker, /malformed/i);
});
