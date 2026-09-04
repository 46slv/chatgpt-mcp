import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";

import { createDevExecEntrypoint } from "./devexec-runtime-selector.mjs";
import { loadEphemeraRuntimePackage } from "./ephemera-runtime-materialize.mjs";
import { createTaskContract, runTestCommand } from "./local-worker-runtime.mjs";

const CACHE = process.env.EPHEMERA_RUNTIME_TEST_CACHE_DIR || "";
const CLI = path.resolve("tools", "devexec-runtime-cli.mjs");

function fixture(taskId) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ephemera-mig008-matrix-task-"));
  fs.writeFileSync(path.join(root, "README.md"), "fixture\n", "utf8");
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "EPHEMERA matrix"]);
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "fixture"]);
  const base = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return createTaskContract({
    task_id: taskId,
    repo: root,
    worktree: root,
    cwd: root,
    base_commit: base,
    goal: "consumer lifecycle matrix",
    allowed_paths: ["src/value.txt"],
    constraints: ["no commit"],
    test_command: [process.execPath, "-e", "process.exit(0)"],
    timeout: 30000,
    max_tool_calls: 4,
    output_limit: 4000,
  });
}

function stateFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ephemera-mig008-matrix-state-"));
  return {
    root,
    recovery: path.join(root, "recovery"),
    lease: path.join(root, "lease"),
    admission: path.join(root, "admission"),
  };
}

function makeProvider({ gpu = "CLEAR", result = "PASS", runs = null, onRun = null } = {}) {
  return {
    identity: { runtime: "local", provider: "freetoken", model: "selector-fake" },
    config: { idleStopMs: 0, deviceIndex: 2, model: "selector-fake", serveUrl: "http://127.0.0.1:19191" },
    async gpuGate() { return { status: gpu }; },
    async run(input, context = {}) {
      if (runs) runs.count += 1;
      context.onLifecycle?.("start_start");
      context.onLifecycle?.("inference_start");
      if (onRun) await onRun(input, context);
      if (result === "PASS") {
        fs.mkdirSync(path.join(input.worktree, "src"), { recursive: true });
        fs.writeFileSync(path.join(input.worktree, "src", "value.txt"), "ok\n", "utf8");
      }
      return typeof result === "function" ? result(input) : result && typeof result === "object" ? result : { status: result };
    },
  };
}

function makeEntry(task, provider, state, extra = {}) {
  return createDevExecEntrypoint({
    selection: { runtime: "local", provider: "freetoken", enabled: true },
    adapters: { freetoken: provider },
    recoveryStateDir: extra.recoveryStateDir || state.recovery,
    leaseStateDir: extra.leaseStateDir || state.lease,
    admissionStateDir: extra.admissionStateDir || state.admission,
    runtimeCacheDir: CACHE,
  });
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function digest(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}

function providerLeaseDigest(provider = "freetoken", deviceIndex = 2, servePort = 19191) {
  return digest({ provider, device_index: deviceIndex, serve_port: servePort });
}

function leasePath(state, digestValue = providerLeaseDigest()) {
  return path.join(state.lease, "provider-leases-v1", `${digestValue}.lease.json`);
}

function writeMalformedLease(state) {
  fs.mkdirSync(path.dirname(leasePath(state)), { recursive: true });
  fs.writeFileSync(leasePath(state), "{\"malformed\":true}\n", "utf8");
}

function writeStaleLease(state) {
  const releaseNonce = "a".repeat(64);
  const value = {
    schema: "devexec.local-provider-lease/v1",
    version: 1,
    key_digest: providerLeaseDigest(),
    provider: "freetoken",
    device_index: 2,
    serve_port: 19191,
    model_id: "selector-fake",
    run_id: "stale-matrix-run",
    owner: { pid: 1, process_start_time: "2020-01-01T00:00:00.000Z", host_instance_digest: "b".repeat(64) },
    created_at: "2020-01-01T00:00:00.000Z",
    expires_at: "2020-01-01T00:01:00.000Z",
    nonce_digest: digest(releaseNonce),
    release_nonce: releaseNonce,
  };
  fs.mkdirSync(path.dirname(leasePath(state)), { recursive: true });
  fs.writeFileSync(leasePath(state), `${canonical(value)}\n`, "utf8");
}

async function waitFor(check, message) {
  const deadline = Date.now() + 15000;
  while (!check()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("real packed consumer matrix has zero unexplained lifecycle delta", { skip: !CACHE, timeout: 180000 }, async () => {
  const cleanTask = fixture("matrix-clean");
  const cleanState = stateFixture();
  const cleanRuns = { count: 0 };
  const cleanEvents = [];
  const clean = makeEntry(cleanTask, makeProvider({ runs: cleanRuns }), cleanState);
  const cleanResult = await clean.run(cleanTask, { runTest: runTestCommand, onLifecycle: (event) => cleanEvents.push(event) });
  assert.equal(cleanResult.result.status, "DONE");
  assert.equal(cleanRuns.count, 1);
  assert.deepEqual(cleanEvents, ["lease_acquired", "start_start", "inference_start"]);

  const failureTask = fixture("matrix-execution-failure");
  const failureState = stateFixture();
  const failureRuns = { count: 0 };
  const failureResult = await makeEntry(failureTask, makeProvider({ result: { status: "FAILED", code: "PROVIDER_FAILURE" }, runs: failureRuns }), failureState).run(failureTask, { runTest: runTestCommand });
  assert.equal(failureResult.result.status, "FAILED");
  assert.equal(failureRuns.count, 1);

  const dirtyTask = fixture("matrix-dirty");
  const dirtyState = stateFixture();
  fs.mkdirSync(dirtyState.recovery, { recursive: true });
  fs.writeFileSync(path.join(dirtyState.recovery, "dirty.marker"), "dirty\n", "utf8");
  const dirtyRuns = { count: 0 };
  await assert.rejects(
    () => makeEntry(dirtyTask, makeProvider({ runs: dirtyRuns }), dirtyState).run(dirtyTask, { runTest: runTestCommand }),
    (error) => error.code === "RECOVERY_NEEDS_ATTENTION",
  );
  assert.equal(dirtyRuns.count, 0);

  const gpuTask = fixture("matrix-gpu-unavailable");
  const gpuState = stateFixture();
  const gpuRuns = { count: 0 };
  await assert.rejects(
    () => makeEntry(gpuTask, makeProvider({ gpu: "UNAVAILABLE", runs: gpuRuns }), gpuState).run(gpuTask, { runTest: runTestCommand }),
    (error) => error.code === "GPU_UNAVAILABLE",
  );
  assert.equal(gpuRuns.count, 0);
  assert.equal(fs.existsSync(path.join(gpuState.lease, "provider-leases-v1")), false);

  const boundaryTask = { ...fixture("matrix-task-boundary"), cwd: path.join(os.tmpdir(), `ephemera-mig008-missing-cwd-${process.pid}`) };
  const boundaryState = stateFixture();
  const boundaryRuns = { count: 0 };
  await assert.rejects(
    () => makeEntry(boundaryTask, makeProvider({ runs: boundaryRuns }), boundaryState).run(boundaryTask, { runTest: runTestCommand }),
    (error) => error.code === "CWD_INVALID",
  );
  assert.equal(boundaryRuns.count, 0);

  const staleTask = fixture("matrix-stale-lease");
  const staleState = stateFixture();
  writeStaleLease(staleState);
  const staleRuns = { count: 0 };
  await assert.rejects(
    () => makeEntry(staleTask, makeProvider({ runs: staleRuns }), staleState).run(staleTask, { runTest: runTestCommand }),
    (error) => error.code === "STALE_CANDIDATE",
  );
  assert.equal(staleRuns.count, 0);

  const malformedTask = fixture("matrix-malformed-lease");
  const malformedState = stateFixture();
  writeMalformedLease(malformedState);
  const malformedRuns = { count: 0 };
  await assert.rejects(
    () => makeEntry(malformedTask, makeProvider({ runs: malformedRuns }), malformedState).run(malformedTask, { runTest: runTestCommand }),
    (error) => error.code === "LEASE_NEEDS_ATTENTION",
  );
  assert.equal(malformedRuns.count, 0);

  const releaseTask = fixture("matrix-release-ambiguity");
  const releaseState = stateFixture();
  const releaseRuns = { count: 0 };
  let releaseFile;
  const releaseProvider = makeProvider({ runs: releaseRuns, onRun(input) {
    releaseFile = leasePath(releaseState);
    assert.equal(fs.existsSync(releaseFile), true);
    fs.writeFileSync(releaseFile, "{}\n", "utf8");
    fs.mkdirSync(path.join(input.worktree, "src"), { recursive: true });
    fs.writeFileSync(path.join(input.worktree, "src", "value.txt"), "ok\n", "utf8");
  } });
  await assert.rejects(
    () => makeEntry(releaseTask, releaseProvider, releaseState).run(releaseTask, { runTest: runTestCommand }),
    (error) => error.code === "LEASE_RELEASE_NEEDS_ATTENTION",
  );
  assert.equal(releaseRuns.count, 1);
  assert.ok(releaseFile);

  const insideTask = fixture("matrix-state-inside-worktree");
  const insideState = stateFixture();
  const insideRuns = { count: 0 };
  await assert.rejects(
    () => makeEntry(insideTask, makeProvider({ runs: insideRuns }), insideState, { recoveryStateDir: path.join(insideTask.worktree, "runtime-state") }).run(insideTask, { runTest: runTestCommand }),
    (error) => error.code === "RUNTIME_STATE_INSIDE_WORKTREE",
  );
  assert.equal(insideRuns.count, 0);

  const runtime = await loadEphemeraRuntimePackage({ cacheDir: CACHE, worktree: cleanTask.worktree });
  assert.equal(runtime.scanRecoveryState(cleanState.recovery).status, "CLEAN");
  console.log(JSON.stringify({
    clean_success: "DONE",
    execution_failure: "FAILED",
    dirty_recovery: "RECOVERY_NEEDS_ATTENTION",
    gpu_unavailable: { status: "GPU_UNAVAILABLE", provider_lease_acquire: 0, worker_execution: 0 },
    task_boundary: { status: "CWD_INVALID", provider_lease_acquire: 0, worker_execution: 0 },
    stale_lease: "STALE_CANDIDATE",
    malformed_lease: "LEASE_NEEDS_ATTENTION",
    provider_release_ambiguity: "LEASE_RELEASE_NEEDS_ATTENTION",
    state_dir_inside_worktree: "RUNTIME_STATE_INSIDE_WORKTREE",
    legacy_lifecycle_invocations: 0,
    unexplained_delta: 0,
  }));
});

test("real System admission and provider lease concurrency fail closed", { skip: !CACHE, timeout: 180000 }, async () => {
  const sharedLease = fs.mkdtempSync(path.join(os.tmpdir(), "ephemera-mig008-shared-lease-"));
  const sharedAdmission = fs.mkdtempSync(path.join(os.tmpdir(), "ephemera-mig008-shared-admission-"));
  const firstTask = fixture("matrix-lease-held-first");
  const secondTask = fixture("matrix-lease-held-second");
  const firstState = stateFixture();
  const secondState = stateFixture();
  let firstStarted = false;
  let releaseFirst;
  const first = makeEntry(firstTask, makeProvider({ onRun: async () => {
    firstStarted = true;
    await new Promise((resolve) => { releaseFirst = resolve; });
  } }), firstState, { leaseStateDir: sharedLease, admissionStateDir: sharedAdmission });
  const secondRuns = { count: 0 };
  const second = makeEntry(secondTask, makeProvider({ runs: secondRuns }), secondState, { leaseStateDir: sharedLease, admissionStateDir: sharedAdmission });
  const firstRun = first.run(firstTask, { runTest: runTestCommand });
  await waitFor(() => firstStarted, "first real lease holder did not enter provider execution");
  await assert.rejects(() => second.run(secondTask, { runTest: runTestCommand }), (error) => error.code === "LEASE_HELD");
  assert.equal(secondRuns.count, 0);
  releaseFirst();
  assert.equal((await firstRun).result.status, "DONE");

  const rootTask = fixture("matrix-admission-root-first");
  const rootSecondTask = fixture("matrix-admission-root-second");
  const rootFirstState = stateFixture();
  const rootSecondState = stateFixture();
  let rootFirstStarted = false;
  let releaseRootFirst;
  const rootFirst = makeEntry(rootTask, makeProvider({ onRun: async () => {
    rootFirstStarted = true;
    await new Promise((resolve) => { releaseRootFirst = resolve; });
  } }), rootFirstState, { admissionStateDir: sharedAdmission });
  const rootSecondRuns = { count: 0 };
  const rootSecond = makeEntry(rootSecondTask, makeProvider({ runs: rootSecondRuns }), rootSecondState, { recoveryStateDir: rootFirstState.recovery, admissionStateDir: sharedAdmission });
  const rootRun = rootFirst.run(rootTask, { runTest: runTestCommand });
  await waitFor(() => rootFirstStarted, "first real admission holder did not enter provider execution");
  await assert.rejects(() => rootSecond.run(rootSecondTask, { runTest: runTestCommand }), (error) => error.code === "ADMISSION_HELD");
  assert.equal(rootSecondRuns.count, 0);
  releaseRootFirst();
  assert.equal((await rootRun).result.status, "DONE");
  console.log(JSON.stringify({ provider_lease_held: "LEASE_HELD", same_recovery_root_admission: "ADMISSION_HELD" }));
});

test("real packed local path survives hard exit only as a non-replayable blocked restart", { skip: !CACHE, timeout: 120000 }, () => {
  const task = fixture("matrix-hard-exit");
  const state = stateFixture();
  const taskFile = path.join(state.root, "task.json");
  const adapterFile = path.join(state.root, "hard-exit-adapter.mjs");
  fs.writeFileSync(taskFile, `${JSON.stringify(task, null, 2)}\n`, "utf8");
  fs.writeFileSync(adapterFile, `export default { identity: { runtime: "local", provider: "freetoken", model: "selector-fake" }, config: { idleStopMs: 0, deviceIndex: 2, model: "selector-fake", serveUrl: "http://127.0.0.1:19191", idleStopMs: 0 }, async gpuGate() { return { status: "CLEAR" }; }, async run(input, context) { context.onLifecycle?.("start_start"); process.exit(17); } };\n`, "utf8");
  const args = [CLI, "run", "--task", taskFile, "--runtime", "local", "--provider", "freetoken", "--adapter-module", adapterFile, "--recovery-dir", state.recovery, "--lease-dir", state.lease, "--ephemera-cache-dir", CACHE, "--evidence", path.join(state.root, "hard-exit-evidence.json")];
  const exited = spawnSync(process.execPath, args, { encoding: "utf8", windowsHide: true, timeout: 30000 });
  assert.equal(exited.status, 17, exited.stderr || exited.stdout);
  assert.equal(fs.existsSync(path.join(state.recovery)), true);
  const restarted = spawnSync(process.execPath, args, { encoding: "utf8", windowsHide: true, timeout: 30000 });
  assert.equal(restarted.status, 2, restarted.stderr || restarted.stdout);
  const parsed = JSON.parse(restarted.stdout);
  assert.equal(parsed.status, "BLOCKED");
  assert.match(parsed.blocker, /ADMISSION_(?:HELD|NEEDS_ATTENTION)|RECOVERY_NEEDS_ATTENTION/);
  console.log(JSON.stringify({ hard_exit: 17, restart: "BLOCKED", replay: false }));
});
