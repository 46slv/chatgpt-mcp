import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  createDevExecEntrypoint,
  resolveDevExecRuntimeSelection,
  DEVEXEC_RUNTIME,
  DEVEXEC_PROVIDER,
} from "./devexec-runtime-selector.mjs";
import { loadEphemeraRuntimePackage } from "./ephemera-runtime-materialize.mjs";
import { createTaskContract, runTestCommand } from "./local-worker-runtime.mjs";

const CACHE = process.env.EPHEMERA_RUNTIME_TEST_CACHE_DIR || "";

function fixture(taskId = "selector-fixture") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-selector-"));
  fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "DevExec Test"]);
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "fixture"]);
  const base = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return createTaskContract({
    task_id: taskId,
    repo: root,
    worktree: root,
    goal: "bounded local edit",
    allowed_paths: ["src/value.txt"],
    constraints: ["no commit"],
    test_command: [process.execPath, "-e", "process.exit(0)"],
    timeout: 30000,
    max_tool_calls: 4,
    output_limit: 4000,
    base_commit: base,
  });
}

function stateDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ephemera-selector-state-"));
  return { root, recoveryStateDir: path.join(root, "recovery"), leaseStateDir: path.join(root, "lease") };
}

function localOptions(task, provider, state = stateDirs()) {
  return {
    selection: { runtime: "local", provider: "freetoken", enabled: true },
    adapters: { freetoken: provider },
    recoveryStateDir: state.recoveryStateDir,
    leaseStateDir: state.leaseStateDir,
    runtimeCacheDir: CACHE || path.join(state.root, "missing-cache"),
  };
}

function provider({ gpuStatus = "CLEAR", result = "PASS", events = [], runs = null } = {}) {
  return {
    identity: { runtime: "local", provider: "freetoken", model: "selector-fake" },
    config: { idleStopMs: 0, deviceIndex: 2, model: "selector-fake", serveUrl: "http://127.0.0.1:19191" },
    async gpuGate() { events.push("gpu"); return { status: gpuStatus }; },
    async run(input, context = {}) {
      if (runs) runs.count += 1;
      events.push("provider-run");
      context.onLifecycle?.("start_start");
      context.onLifecycle?.("inference_start");
      if (result === "PASS") {
        fs.mkdirSync(path.join(input.worktree, "src"), { recursive: true });
        fs.writeFileSync(path.join(input.worktree, "src/value.txt"), "ok\n");
      }
      return typeof result === "function" ? result(input) : { status: result };
    },
  };
}

test("default and disabled selection retain the existing adapter path", async () => {
  const existing = { async run(value) { return { path: value }; } };
  const defaultEntry = createDevExecEntrypoint({ adapters: { default: existing } });
  assert.deepEqual(defaultEntry.selection, { runtime: DEVEXEC_RUNTIME.DEFAULT, provider: DEVEXEC_PROVIDER.EXISTING, explicit: false, enabled: false });
  assert.deepEqual(await defaultEntry.run("cloud"), { path: "cloud" });
  const disabled = createDevExecEntrypoint({
    selection: { runtime: "local", provider: "freetoken", enabled: false },
    adapters: { default: existing, freetoken: { async run() { throw new Error("must not route"); } } },
  });
  assert.deepEqual(await disabled.run("existing"), { path: "existing" });
});

test("explicit local selection uses the packed System lifecycle and preserves GPU/lease/worker ordering", { skip: !CACHE }, async () => {
  const task = fixture();
  const state = stateDirs();
  const events = [];
  const entry = createDevExecEntrypoint(localOptions(task, provider({ events }), state));
  const lifecycleEvents = [];
  const outcome = await entry.run(task, { runTest: runTestCommand, onLifecycle: (event) => lifecycleEvents.push(event) });
  assert.equal(outcome.result.status, "DONE");
  assert.equal(events[0], "gpu");
  assert.equal(events.at(-1), "provider-run");
  assert.deepEqual(lifecycleEvents, ["lease_acquired", "start_start", "inference_start"]);
  const runtime = await loadEphemeraRuntimePackage({ cacheDir: CACHE, worktree: task.worktree });
  assert.equal(runtime.scanRecoveryState(state.recoveryStateDir).status, "CLEAN");
});

test("GPU unavailable and TaskBoundary failure stop before provider lease and worker", { skip: !CACHE }, async () => {
  const gpuTask = fixture("selector-gpu");
  const gpuState = stateDirs();
  const gpuRuns = { count: 0 };
  const gpuEntry = createDevExecEntrypoint(localOptions(gpuTask, provider({ gpuStatus: "UNAVAILABLE", runs: gpuRuns }), gpuState));
  await assert.rejects(() => gpuEntry.run(gpuTask, { runTest: runTestCommand }), (error) => error.code === "GPU_UNAVAILABLE");
  assert.equal(gpuRuns.count, 0);
  assert.equal(fs.existsSync(path.join(gpuState.leaseStateDir, "provider-leases-v1")), false);

  const boundaryTask = { ...fixture("selector-boundary"), cwd: path.join(os.tmpdir(), `missing-boundary-cwd-${process.pid}`) };
  const boundaryState = stateDirs();
  const boundaryRuns = { count: 0 };
  const boundaryEntry = createDevExecEntrypoint(localOptions(boundaryTask, provider({ runs: boundaryRuns }), boundaryState));
  await assert.rejects(() => boundaryEntry.run(boundaryTask, { runTest: runTestCommand }), (error) => error.code === "CWD_INVALID");
  assert.equal(boundaryRuns.count, 0);
  assert.equal(fs.existsSync(path.join(boundaryState.leaseStateDir, "provider-leases-v1")), false);
});

test("dirty recovery skips the hook and explicit local runtime without a package is BLOCKED", { skip: !CACHE }, async () => {
  const task = fixture("selector-dirty");
  const state = stateDirs();
  fs.mkdirSync(state.recoveryStateDir, { recursive: true });
  fs.writeFileSync(path.join(state.recoveryStateDir, "dirty.marker"), "dirty\n");
  const runs = { count: 0 };
  const entry = createDevExecEntrypoint(localOptions(task, provider({ runs }), state));
  await assert.rejects(() => entry.run(task, { runTest: runTestCommand }), (error) => error.code === "RECOVERY_NEEDS_ATTENTION");
  assert.equal(runs.count, 0);
  assert.equal(fs.existsSync(path.join(state.leaseStateDir, "provider-leases-v1")), false);

  const missingTask = fixture("selector-unmaterialized");
  const missingState = stateDirs();
  let legacyRuns = 0;
  const blockedEntry = createDevExecEntrypoint({ ...localOptions(missingTask, {
    identity: { runtime: "local", provider: "freetoken" },
    config: { idleStopMs: 0 },
    async run() { legacyRuns += 1; throw new Error("legacy fallback must not run"); },
  }, missingState), runtimeCacheDir: path.join(missingState.root, "missing-cache") });
  await assert.rejects(() => blockedEntry.run(missingTask), (error) => error.code === "EPHEMERA_RUNTIME_NOT_MATERIALIZED");
  assert.equal(legacyRuns, 0);
});

test("state directories inside the worktree are rejected before package lifecycle", async () => {
  const task = fixture("selector-inside");
  let runs = 0;
  const entry = createDevExecEntrypoint({
    selection: { runtime: "local", provider: "freetoken", enabled: true },
    adapters: { freetoken: { identity: { runtime: "local", provider: "freetoken" }, config: { idleStopMs: 0 }, async run() { runs += 1; } } },
    recoveryStateDir: path.join(task.worktree, "runtime-state"),
    leaseStateDir: path.join(task.worktree, "lease-state"),
    runtimeCacheDir: path.join(task.worktree, "cache"),
  });
  await assert.rejects(() => entry.run(task, { runTest: runTestCommand }), (error) => error.code === "RUNTIME_STATE_INSIDE_WORKTREE");
  assert.equal(runs, 0);
});

test("switched selector has no source-owned recovery journal/provider lease imports or lifecycle override seam", () => {
  const source = fs.readFileSync(new URL("./devexec-runtime-selector.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /local-runtime-recovery-journal\.mjs/);
  assert.doesNotMatch(source, /local-provider-lease\.mjs/);
  assert.doesNotMatch(source, /ephemeraRuntime|ephemeraRuntimeLoader|ephemeraLifecycleFactory|ephemeraLifecycleOptions/);
  assert.match(source, /createSystemLocalRuntimeLifecycle/);
  assert.match(source, /beforeProviderLease/);
  assert.doesNotMatch(source, /before_provider_lease/);
});

test("runtime selection contract remains explicit and provider-neutral", () => {
  assert.deepEqual(resolveDevExecRuntimeSelection({ runtime: "local", provider: "freetoken", enabled: true }), { runtime: "local", provider: "freetoken", explicit: true, enabled: true });
  assert.throws(() => resolveDevExecRuntimeSelection({ runtime: "local", provider: "unknown", enabled: true }), (error) => error.code === "UNSUPPORTED_PROVIDER");
});
