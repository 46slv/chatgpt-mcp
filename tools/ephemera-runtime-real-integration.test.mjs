import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";

import { createDevExecEntrypoint } from "./devexec-runtime-selector.mjs";
import { loadEphemeraRuntimePackage } from "./ephemera-runtime-materialize.mjs";
import { createTaskContract, runTestCommand } from "./local-worker-runtime.mjs";

const CACHE = process.env.EPHEMERA_RUNTIME_TEST_CACHE_DIR || "";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ephemera-real-consumer-"));
  fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "DevExec Test"]);
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "fixture"]);
  const base = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return createTaskContract({ task_id: "real-consumer", repo: root, worktree: root, base_commit: base, goal: "packed lifecycle smoke", allowed_paths: ["src/value.txt"], constraints: ["no commit"], test_command: [process.execPath, "-e", "process.exit(0)"], timeout: 30000, max_tool_calls: 4, output_limit: 4000 });
}

test("packed package root drives a clean local lifecycle and resolves Windows helpers", { skip: !CACHE }, async () => {
  const task = fixture();
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "ephemera-real-state-"));
  const lifecycleEvents = [];
  const provider = {
    identity: { runtime: "local", provider: "freetoken", model: "packed-fake", device_index: 0 },
    config: { idleStopMs: 0, deviceIndex: 0, model: "packed-fake", serveUrl: "http://127.0.0.1:1919" },
    async gpuGate() { lifecycleEvents.push("gpu"); return { status: "CLEAR" }; },
    async run(input, context = {}) {
      context.onLifecycle?.("start_start");
      context.onLifecycle?.("inference_start");
      fs.mkdirSync(path.join(input.worktree, "src"), { recursive: true });
      fs.writeFileSync(path.join(input.worktree, "src/value.txt"), "ok\n");
      return { status: "PASS" };
    },
  };
  const entry = createDevExecEntrypoint({ selection: { runtime: "local", provider: "freetoken", enabled: true }, adapters: { freetoken: provider }, recoveryStateDir: path.join(state, "recovery"), leaseStateDir: path.join(state, "lease"), runtimeCacheDir: CACHE });
  const outcome = await entry.run(task, { runTest: runTestCommand, onLifecycle: (event) => lifecycleEvents.push(event) });
  assert.equal(outcome.result.status, "DONE");
  assert.equal(lifecycleEvents[0], "gpu");
  const runtime = await loadEphemeraRuntimePackage({ cacheDir: CACHE, worktree: task.worktree });
  assert.equal(runtime.scanRecoveryState(path.join(state, "recovery")).status, "CLEAN");
  const packageRoot = path.join(CACHE, "node_modules", "@46slv", "ephemera-system-local-runtime");
  assert.equal(fs.statSync(path.join(packageRoot, "tools", "local-runtime-admission-release.ps1")).isFile(), true);
  assert.equal(fs.statSync(path.join(packageRoot, "tools", "devexec-local-provider-lease-release.ps1")).isFile(), true);
});

test("packed lifecycle GPU hook failure is fail-closed with no provider invocation", { skip: !CACHE }, async () => {
  const task = fixture();
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "ephemera-real-gpu-state-"));
  let providerRuns = 0;
  const provider = { identity: { runtime: "local", provider: "freetoken" }, config: { idleStopMs: 0 }, async gpuGate() { return { status: "UNAVAILABLE" }; }, async run() { providerRuns += 1; return { status: "PASS" }; } };
  const entry = createDevExecEntrypoint({ selection: { runtime: "local", provider: "freetoken", enabled: true }, adapters: { freetoken: provider }, recoveryStateDir: path.join(state, "recovery"), leaseStateDir: path.join(state, "lease"), runtimeCacheDir: CACHE });
  await assert.rejects(() => entry.run(task, { runTest: runTestCommand }), (error) => error.code === "GPU_UNAVAILABLE");
  assert.equal(providerRuns, 0);
});

test("explicit CLI local path uses the packed package and reports DONE", { skip: !CACHE }, () => {
  const task = fixture();
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "ephemera-real-cli-state-"));
  const taskFile = path.join(os.tmpdir(), `ephemera-real-cli-task-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  const adapterFile = path.join(os.tmpdir(), `ephemera-real-cli-adapter-${process.pid}-${Math.random().toString(16).slice(2)}.mjs`);
  const evidenceFile = path.join(os.tmpdir(), `ephemera-real-cli-evidence-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(taskFile, `${JSON.stringify(task, null, 2)}\n`, "utf8");
  fs.writeFileSync(adapterFile, `import fs from "node:fs"; export default { identity: { runtime: "local", provider: "freetoken", model: "cli-packed" }, config: { idleStopMs: 0, deviceIndex: 0, model: "cli-packed", serveUrl: "http://127.0.0.1:1919" }, async gpuGate() { return { status: "CLEAR" }; }, async run(input) { fs.mkdirSync(input.worktree + "/src", { recursive: true }); fs.writeFileSync(input.worktree + "/src/value.txt", "ok\\n"); return { status: "PASS" }; } };\n`, "utf8");
  const result = spawnSync(process.execPath, [path.resolve("tools/devexec-runtime-cli.mjs"), "run", "--task", taskFile, "--runtime", "local", "--provider", "freetoken", "--adapter-module", adapterFile, "--recovery-dir", path.join(state, "recovery"), "--lease-dir", path.join(state, "lease"), "--ephemera-cache-dir", CACHE, "--evidence", evidenceFile], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "DONE");
  assert.equal(JSON.parse(fs.readFileSync(evidenceFile, "utf8")).result.status, "DONE");
});
