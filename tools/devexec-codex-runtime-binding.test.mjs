import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CODEX_CONTINUATION_ERRORS,
  buildCodexContinuationInvocation,
  createCodexContinuationBinding,
  createCodexContinuationReturn,
  createCodexContinuationSender,
} from "./devexec-codex-continuation.mjs";
import {
  CODEX_RUNTIME_ERRORS,
  CODEX_RUNTIME_BINDING_PROTOCOL,
  CODEX_RUNTIME_BINDING_SCHEMA_VERSION,
  createCodexRuntimeBinding,
  parseCodexRuntimeCapabilities,
  probeCodexRuntime,
  validateCodexRuntimeBinding,
  verifyCodexRuntimeBinding,
} from "./devexec-codex-runtime-binding.mjs";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-codex-runtime-binding-"));
const WORK = path.join(ROOT, "work");
const THREAD_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const THREAD_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BOUND_AT = "2026-09-02T20:00:00.000Z";
let fileNumber = 0;

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function runtime({ name = `codex-${++fileNumber}.exe`, content = "runtime-v1", version = "codex-cli test 1.0.0", queue = true, resume = true, launch_args = [] } = {}) {
  const executablePath = path.join(ROOT, name);
  fs.writeFileSync(executablePath, content, "utf8");
  return createCodexRuntimeBinding({
    executable_path: executablePath,
    launch_args,
    version,
    capabilities: { queue, resume },
    bound_at: BOUND_AT,
    provenance: "test-fixture",
  });
}

function taskBinding({ task_id = "task-a", thread_id = THREAD_A } = {}) {
  return createCodexContinuationBinding({
    mission_id: "mission-runtime",
    task_id,
    thread_id,
    working_directory: WORK,
    repo_root: ROOT,
    bound_at: BOUND_AT,
  });
}

function request(binding, prompt = "continue", response_id = "response-1") {
  return createCodexContinuationReturn({ binding, prompt, response_id });
}

test("explicit runtime binding is immutable and deterministic", () => {
  const first = runtime({ name: "deterministic.exe" });
  const second = createCodexRuntimeBinding({
    executable_path: first.executable_path,
    launch_args: first.launch_args,
    version: first.version,
    capabilities: first.capabilities,
    fingerprint_files: first.fingerprint_files,
    bound_at: first.bound_at,
    provenance: first.provenance,
  });
  assert.equal(first.protocol, CODEX_RUNTIME_BINDING_PROTOCOL);
  assert.equal(first.schema_version, CODEX_RUNTIME_BINDING_SCHEMA_VERSION);
  assert.equal(first.binding_id, second.binding_id);
  assert.equal(first.runtime_fingerprint, second.runtime_fingerprint);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.capabilities), true);
  assert.equal(Object.isFrozen(first.fingerprint_files), true);
});

test("different paths, versions, and capabilities cannot share a runtime identity", () => {
  const first = runtime({ name: "identity-a.exe" });
  const differentPath = runtime({ name: "identity-b.exe" });
  const differentVersion = runtime({ name: "identity-a-version.exe", version: "codex-cli test 2.0.0" });
  const differentCapabilities = runtime({ name: "identity-a-capability.exe", queue: false, resume: true });
  assert.notEqual(first.binding_id, differentPath.binding_id);
  assert.notEqual(first.binding_id, differentVersion.binding_id);
  assert.notEqual(first.binding_id, differentCapabilities.binding_id);
});

test("continuation invocation uses the bound absolute runtime and launch vector", () => {
  const bound = taskBinding();
  const runtimeBound = runtime({ name: "absolute-runtime.exe", launch_args: ["--profile", "fixed"] });
  const invocation = buildCodexContinuationInvocation({ binding: bound, request: request(bound), mode: "queue", runtime: runtimeBound });
  assert.equal(invocation.command, runtimeBound.executable_path);
  assert.deepEqual(invocation.args.slice(0, 2), ["--profile", "fixed"]);
  assert.equal(invocation.args.includes("codex"), false);
  assert.equal(invocation.args.includes("--last"), false);
  assert.equal(invocation.runtime_binding_id, runtimeBound.binding_id);
});

test("changing PATH after admission does not change the bound invocation", () => {
  const bound = taskBinding();
  const runtimeBound = runtime({ name: "path-stable.exe" });
  const before = buildCodexContinuationInvocation({ binding: bound, request: request(bound), mode: "queue", runtime: runtimeBound });
  const original = process.env.PATH;
  try {
    process.env.PATH = `${path.join(ROOT, "other-bin")};C:\\malicious\\bin`;
    const after = buildCodexContinuationInvocation({ binding: bound, request: request(bound), mode: "queue", runtime: runtimeBound });
    assert.equal(after.command, before.command);
    assert.deepEqual(after.args, before.args);
  } finally {
    if (original === undefined) delete process.env.PATH;
    else process.env.PATH = original;
  }
});

test("runtime file, version, and capability drift are rejected", () => {
  const runtimeBound = runtime({ name: "drift-file.exe" });
  fs.writeFileSync(runtimeBound.executable_path, "runtime-replaced", "utf8");
  assert.throws(() => verifyCodexRuntimeBinding(runtimeBound), (error) => error.code === CODEX_RUNTIME_ERRORS.DRIFT);

  const observedBound = runtime({ name: "drift-observed.exe" });
  assert.throws(() => verifyCodexRuntimeBinding(observedBound, {
    observed: { version: "codex-cli test 9.9.9", capabilities: observedBound.capabilities },
  }), (error) => error.code === CODEX_RUNTIME_ERRORS.DRIFT);
  assert.throws(() => verifyCodexRuntimeBinding(observedBound, {
    observed: { version: observedBound.version, capabilities: { queue: false, resume: true } },
  }), (error) => error.code === CODEX_RUNTIME_ERRORS.DRIFT);
});

test("missing bound runtime is rejected without a fallback", async () => {
  const bound = taskBinding();
  const runtimeBound = runtime({ name: "missing-runtime.exe" });
  fs.unlinkSync(runtimeBound.executable_path);
  assert.throws(() => verifyCodexRuntimeBinding(runtimeBound), (error) => error.code === CODEX_RUNTIME_ERRORS.UNAVAILABLE);
  let calls = 0;
  const sender = createCodexContinuationSender({
    binding: bound,
    runtime: runtimeBound,
    invoke: async () => { calls += 1; return { thread_id: THREAD_A }; },
  });
  await assert.rejects(() => sender.send(request(bound, "missing", "missing-runtime-response")), (error) => error.code === CODEX_RUNTIME_ERRORS.UNAVAILABLE);
  assert.equal(calls, 0);
});

test("required queue capability fails closed without switching runtime", async () => {
  const bound = taskBinding({ task_id: "queue-required" });
  const runtimeBound = runtime({ name: "resume-only.exe", queue: false, resume: true });
  assert.throws(
    () => buildCodexContinuationInvocation({ binding: bound, request: request(bound), mode: "queue", runtime: runtimeBound }),
    (error) => error.code === CODEX_RUNTIME_ERRORS.CAPABILITY_UNAVAILABLE,
  );
  let calls = 0;
  const sender = createCodexContinuationSender({
    binding: bound,
    runtime: runtimeBound,
    required_mode: "queue",
    invoke: async () => { calls += 1; return { thread_id: THREAD_A }; },
  });
  await assert.rejects(() => sender.send(request(bound, "queue required", "queue-required-response")), (error) => error.code === CODEX_RUNTIME_ERRORS.CAPABILITY_UNAVAILABLE);
  assert.equal(calls, 0);
  assert.equal(sender.inspect(request(bound, "queue required", "queue-required-response").return_id).status, "REJECTED");
});

test("Task A and Task B keep distinct runtime and thread bindings", async () => {
  const taskA = taskBinding({ task_id: "runtime-a", thread_id: THREAD_A });
  const taskB = taskBinding({ task_id: "runtime-b", thread_id: THREAD_B });
  const runtimeA = runtime({ name: "runtime-a.exe" });
  const runtimeB = runtime({ name: "runtime-b.exe", version: "codex-cli test 2.0.0" });
  const seen = [];
  const invoke = async (invocation) => {
    seen.push({ command: invocation.command, thread_id: invocation.thread_id, prompt: invocation.args.at(-1) });
    return { thread_id: invocation.thread_id };
  };
  const senderA = createCodexContinuationSender({ binding: taskA, runtime: runtimeA, invoke });
  const senderB = createCodexContinuationSender({ binding: taskB, runtime: runtimeB, invoke });
  const [resultA, resultB] = await Promise.all([
    senderA.send(request(taskA, "prompt-a", "return-a")),
    senderB.send(request(taskB, "prompt-b", "return-b")),
  ]);
  assert.deepEqual(new Map(seen.map((entry) => [entry.thread_id, entry])), new Map([
    [THREAD_A, { command: runtimeA.executable_path, thread_id: THREAD_A, prompt: "prompt-a" }],
    [THREAD_B, { command: runtimeB.executable_path, thread_id: THREAD_B, prompt: "prompt-b" }],
  ]));
  assert.deepEqual(new Set([resultA.thread_id, resultB.thread_id]), new Set([THREAD_A, THREAD_B]));
});

test("runtime verification failure cannot fall back to another binary", async () => {
  const bound = taskBinding({ task_id: "no-runtime-fallback" });
  const runtimeBound = runtime({ name: "no-fallback.exe" });
  let calls = 0;
  const sender = createCodexContinuationSender({
    binding: bound,
    runtime: runtimeBound,
    runtimeProbe: async () => ({ version: "codex-cli test other", capabilities: runtimeBound.capabilities }),
    invoke: async () => { calls += 1; return { thread_id: THREAD_A }; },
  });
  await assert.rejects(() => sender.send(request(bound, "drift", "no-fallback-response")), (error) => error.code === CODEX_RUNTIME_ERRORS.DRIFT);
  assert.equal(calls, 0);
});

test("runtime drift after one continuation blocks the next distinct return", async () => {
  const bound = taskBinding({ task_id: "drift-after-send" });
  const runtimeBound = runtime({ name: "drift-after-send.exe" });
  const sender = createCodexContinuationSender({
    binding: bound,
    runtime: runtimeBound,
    invoke: async (invocation) => ({ thread_id: invocation.thread_id }),
  });
  await sender.send(request(bound, "first", "drift-after-first"));
  fs.writeFileSync(runtimeBound.executable_path, "runtime-replaced-after-send", "utf8");
  await assert.rejects(() => sender.send(request(bound, "second", "drift-after-second")), (error) => error.code === CODEX_RUNTIME_ERRORS.DRIFT);
});

test("runtime probe path and launch-vector drift is rejected before invocation", async () => {
  const bound = taskBinding({ task_id: "probe-identity-drift" });
  const runtimeBound = runtime({ name: "probe-identity.exe", launch_args: ["--fixed"] });
  let calls = 0;
  const sender = createCodexContinuationSender({
    binding: bound,
    runtime: runtimeBound,
    runtimeProbe: async () => ({
      executable_path: path.join(ROOT, "other-runtime.exe"),
      launch_args: ["--other"],
      version: runtimeBound.version,
      capabilities: runtimeBound.capabilities,
    }),
    invoke: async () => { calls += 1; return { thread_id: THREAD_A }; },
  });
  await assert.rejects(() => sender.send(request(bound, "probe identity", "probe-identity-response")), (error) => error.code === CODEX_RUNTIME_ERRORS.DRIFT);
  assert.equal(calls, 0);
});

test("an empty explicit runtime probe fails closed", async () => {
  const bound = taskBinding({ task_id: "empty-probe" });
  const runtimeBound = runtime({ name: "empty-probe-runtime.exe" });
  let calls = 0;
  const sender = createCodexContinuationSender({
    binding: bound,
    runtime: runtimeBound,
    runtimeProbe: async () => null,
    invoke: async () => { calls += 1; return { thread_id: THREAD_A }; },
  });
  await assert.rejects(() => sender.send(request(bound, "empty probe", "empty-probe-response")), (error) => error.code === CODEX_RUNTIME_ERRORS.PROBE_FAILED);
  assert.equal(calls, 0);
});

test("an untyped runtime probe failure is converted to a typed rejection", async () => {
  const bound = taskBinding({ task_id: "untyped-probe" });
  const runtimeBound = runtime({ name: "untyped-probe-runtime.exe" });
  const sender = createCodexContinuationSender({
    binding: bound,
    runtime: runtimeBound,
    runtimeProbe: async () => { throw new Error("probe unavailable"); },
    invoke: async () => { throw new Error("must not invoke"); },
  });
  await assert.rejects(() => sender.send(request(bound, "untyped probe", "untyped-probe-response")), (error) => error.code === CODEX_RUNTIME_ERRORS.PROBE_FAILED);
});

test("script launchers require and verify underlying implementation fingerprints", () => {
  const launcher = path.join(ROOT, "codex.cmd");
  const implementation = path.join(ROOT, "codex.js");
  fs.writeFileSync(launcher, "@echo off\r\n", "utf8");
  fs.writeFileSync(implementation, "console.log('fixture')\n", "utf8");
  assert.throws(() => createCodexRuntimeBinding({
    executable_path: launcher,
    version: "codex-cli shim 1.0.0",
    capabilities: { queue: false, resume: true },
    bound_at: BOUND_AT,
    provenance: "test-shim",
  }), (error) => error.code === CODEX_RUNTIME_ERRORS.INVALID);
  const bound = createCodexRuntimeBinding({
    executable_path: launcher,
    launch_args: [implementation],
    version: "codex-cli shim 1.0.0",
    capabilities: { queue: false, resume: true },
    fingerprint_files: [launcher, implementation],
    bound_at: BOUND_AT,
    provenance: "test-shim",
  });
  verifyCodexRuntimeBinding(bound);
  fs.writeFileSync(implementation, "console.log('changed')\n", "utf8");
  assert.throws(() => verifyCodexRuntimeBinding(bound), (error) => error.code === CODEX_RUNTIME_ERRORS.DRIFT);
});

test("runtime probe uses only the explicit launch path and records version/capabilities", async () => {
  const runtimePath = path.join(ROOT, "probe-runtime.exe");
  fs.writeFileSync(runtimePath, "probe-runtime", "utf8");
  const calls = [];
  const evidence = await probeCodexRuntime({
    executable_path: runtimePath,
    invoke: async ({ command, args, purpose }) => {
      calls.push({ command, args, purpose });
      return args.at(-1) === "--version"
        ? { exitCode: 0, stdout: "codex-cli probe 3.0.0\n" }
        : { exitCode: 0, stdout: "Commands:\n  queue       Queue a message\n  resume      Resume a session\n" };
    },
  });
  assert.equal(evidence.executable_path, runtimePath);
  assert.equal(evidence.version, "codex-cli probe 3.0.0");
  assert.deepEqual(evidence.capabilities, { queue: true, resume: true });
  assert.deepEqual(calls.map((entry) => entry.command), [runtimePath, runtimePath]);
  assert.deepEqual(calls.map((entry) => entry.args), [["--version"], ["--help"]]);
  assert.deepEqual(parseCodexRuntimeCapabilities("Commands:\n  resume      Resume\n"), { queue: false, resume: true });
});

test("PATH-only or unbound runtime input fails closed", () => {
  assert.throws(() => createCodexRuntimeBinding({ version: "codex-cli 1.0.0", capabilities: { queue: true, resume: true } }), (error) => error.code === CODEX_RUNTIME_ERRORS.REQUIRED);
  assert.throws(() => createCodexRuntimeBinding({ executable_path: "codex", version: "codex-cli 1.0.0", capabilities: { queue: true, resume: true } }), (error) => error.code === CODEX_RUNTIME_ERRORS.REQUIRED || error.code === CODEX_RUNTIME_ERRORS.INVALID);
  const bound = taskBinding();
  assert.throws(() => buildCodexContinuationInvocation({ binding: bound, request: request(bound), mode: "queue" }), (error) => error.code === CODEX_RUNTIME_ERRORS.REQUIRED);
});

test("runtime binding validation rejects tampered identity and preserves CGL001 error typing", () => {
  const runtimeBound = runtime({ name: "tamper-runtime.exe" });
  assert.throws(() => validateCodexRuntimeBinding({ ...runtimeBound, version: "codex-cli tampered 9.0.0" }), (error) => error.code === CODEX_RUNTIME_ERRORS.INVALID);
  const bound = taskBinding();
  const sender = createCodexContinuationSender({ binding: bound, runtime: runtimeBound, invoke: async () => ({ thread_id: THREAD_A }) });
  assert.equal(CODEX_CONTINUATION_ERRORS.IDENTITY_MISMATCH, "CONTINUATION_IDENTITY_MISMATCH");
  assert.ok(sender.runtime.binding_id === runtimeBound.binding_id);
});
