import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_CONTINUATION_ERRORS,
  CODEX_CONTINUATION_MODE,
  buildCodexContinuationInvocation,
  createCodexContinuationBinding,
  createCodexContinuationReturn,
  createCodexContinuationSender,
  parseCodexCapabilities,
  parseCodexThreadStartedIds,
  validateCodexContinuationBinding,
  validateCodexContinuationReturn,
} from "./devexec-codex-continuation.mjs";

const BOUND_AT = "2026-09-02T09:00:00.000Z";
const THREAD_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const THREAD_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WORK_A = "D:\\Documents\\Codex\\task-a";
const WORK_B = "D:\\Documents\\Codex\\task-b";

function binding({ mission_id = "mission-1", task_id = "task-a", thread_id = THREAD_A, working_directory = WORK_A } = {}) {
  return createCodexContinuationBinding({ mission_id, task_id, thread_id, working_directory, repo_root: "D:\\Documents\\Codex\\repo", bound_at: BOUND_AT });
}

function continuation(bound, prompt = "continue the same task", response_id = "relay-1") {
  return createCodexContinuationReturn({ binding: bound, prompt, response_id });
}

test("Task A binds to thread A and builds an exact queue command", () => {
  const bound = binding();
  const request = continuation(bound);
  const invocation = buildCodexContinuationInvocation({ binding: bound, request, mode: CODEX_CONTINUATION_MODE.QUEUE });
  assert.equal(bound.protocol, "devexec.codex-continuation-binding");
  assert.equal(bound.thread_id, THREAD_A);
  assert.equal(bound.session_persisted, true);
  assert.equal(Object.isFrozen(bound), true);
  assert.deepEqual(invocation.args, ["queue", "--thread", THREAD_A, "--message", request.prompt]);
  assert.equal(invocation.cwd, WORK_A);
  assert.equal(invocation.args.includes("--last"), false);
});

test("Task A/thread A and Task B/thread B cannot cross-route", () => {
  const taskA = binding();
  const taskB = binding({ task_id: "task-b", thread_id: THREAD_B, working_directory: WORK_B });
  const requestB = continuation(taskB, "B prompt", "relay-b");
  assert.throws(() => validateCodexContinuationReturn(requestB, taskA), (error) => error.code === CODEX_CONTINUATION_ERRORS.TASK_MISMATCH || error.code === CODEX_CONTINUATION_ERRORS.BINDING_MISMATCH);
  const senderA = createCodexContinuationSender({ binding: taskA, capabilities: { queue: true, resume: true }, invoke: async () => ({ thread_id: THREAD_A }) });
  assert.rejects(() => senderA.send(requestB), (error) => error.code === CODEX_CONTINUATION_ERRORS.TASK_MISMATCH || error.code === CODEX_CONTINUATION_ERRORS.BINDING_MISMATCH);
});

test("missing continuation binding fails closed", () => {
  assert.throws(() => createCodexContinuationReturn({ prompt: "prompt", response_id: "relay-1" }), (error) => error.code === CODEX_CONTINUATION_ERRORS.BINDING_REQUIRED);
  assert.throws(() => validateCodexContinuationBinding(null), (error) => error.code === CODEX_CONTINUATION_ERRORS.BINDING_REQUIRED);
});

test("wrong thread or session identity fails closed", () => {
  const bound = binding();
  const wrongThread = { ...bound, thread_id: THREAD_B };
  assert.throws(() => validateCodexContinuationBinding(wrongThread), (error) => error.code === CODEX_CONTINUATION_ERRORS.BINDING_INVALID);
  const request = { ...continuation(bound), thread_id: THREAD_B };
  assert.throws(() => validateCodexContinuationReturn(request, bound), (error) => error.code === CODEX_CONTINUATION_ERRORS.BINDING_MISMATCH);
});

test("autonomous invocation never uses --last, picker, or mutable defaults", () => {
  const bound = binding();
  const request = continuation(bound);
  const queue = buildCodexContinuationInvocation({ binding: bound, request, mode: "queue" });
  const resume = buildCodexContinuationInvocation({ binding: bound, request, mode: "resume" });
  for (const invocation of [queue, resume]) {
    assert.equal(invocation.args.includes("--last"), false);
    assert.equal(invocation.args.includes("--default"), false);
    assert.equal(invocation.args.includes("--picker"), false);
    assert.equal(invocation.args.includes("current-chat"), false);
  }
});

test("same return identity and payload is idempotent with no second dispatch", async () => {
  const bound = binding();
  const request = continuation(bound, "same prompt", "relay-1");
  let calls = 0;
  const sender = createCodexContinuationSender({ binding: bound, capabilities: { queue: true, resume: true }, invoke: async (invocation) => { calls += 1; assert.equal(invocation.mode, "queue"); return { thread_id: THREAD_A }; } });
  assert.equal((await sender.send(request)).status, "DISPATCHED");
  assert.equal((await sender.send(request)).status, "IDEMPOTENT");
  assert.equal(calls, 1);
});

test("same return identity with changed prompt is rejected", async () => {
  const bound = binding();
  const first = continuation(bound, "first", "relay-1");
  const changed = continuation(bound, "changed", "relay-1");
  const sender = createCodexContinuationSender({ binding: bound, capabilities: { queue: true }, invoke: async () => ({ thread_id: THREAD_A }) });
  await sender.send(first);
  await assert.rejects(() => sender.send(changed), (error) => error.code === CODEX_CONTINUATION_ERRORS.RETURN_CONFLICT);
});

test("resume fallback rejects a new or different thread ID", async () => {
  const bound = binding();
  const request = continuation(bound, "resume", "relay-resume");
  const sender = createCodexContinuationSender({
    binding: bound,
    capabilities: { queue: false, resume: true },
    invoke: async () => ({ exitCode: 0, stdout: JSON.stringify({ type: "thread.started", thread_id: THREAD_B }) }),
  });
  await assert.rejects(() => sender.send(request), (error) => error.code === CODEX_CONTINUATION_ERRORS.IDENTITY_MISMATCH);
  assert.equal(sender.inspect(request.return_id).status, "REJECTED");
});

test("resume fallback accepts only the exact reported thread.started.thread_id", async () => {
  const bound = binding();
  const request = continuation(bound, "resume exact", "relay-resume-exact");
  let seen;
  const sender = createCodexContinuationSender({
    binding: bound,
    capabilities: { queue: false, resume: true },
    invoke: async (invocation) => {
      seen = invocation;
      return { exitCode: 0, stdout: JSON.stringify({ type: "thread.started", thread_id: THREAD_A }) };
    },
  });
  const result = await sender.send(request);
  assert.equal(result.status, "DISPATCHED");
  assert.equal(seen.mode, "resume");
  assert.deepEqual(seen.args.slice(0, 4), ["exec", "resume", "--json", THREAD_A]);
  assert.equal(seen.args.includes("--last"), false);
});

test("concurrent Task A and Task B returns preserve their independent thread targets", async () => {
  const taskA = binding({ task_id: "task-a-concurrent", thread_id: THREAD_A });
  const taskB = binding({ task_id: "task-b-concurrent", thread_id: THREAD_B, working_directory: WORK_A });
  const requestA = continuation(taskA, "A concurrent prompt", "relay-a-concurrent");
  const requestB = continuation(taskB, "B concurrent prompt", "relay-b-concurrent");
  const seen = [];
  const invoke = async (invocation) => {
    seen.push({ thread_id: invocation.thread_id, prompt: invocation.args.at(-1) });
    await new Promise((resolve) => setTimeout(resolve, invocation.thread_id === THREAD_A ? 20 : 1));
    return { thread_id: invocation.thread_id };
  };
  const senderA = createCodexContinuationSender({ binding: taskA, capabilities: { queue: true }, invoke });
  const senderB = createCodexContinuationSender({ binding: taskB, capabilities: { queue: true }, invoke });
  const results = await Promise.all([senderA.send(requestA), senderB.send(requestB)]);
  assert.deepEqual(new Map(seen.map((entry) => [entry.thread_id, entry.prompt])), new Map([
    [THREAD_A, requestA.prompt],
    [THREAD_B, requestB.prompt],
  ]));
  assert.deepEqual(new Set(results.map((result) => result.thread_id)), new Set([THREAD_A, THREAD_B]));
});

test("simultaneous duplicate returns reserve one external injection", async () => {
  const bound = binding({ task_id: "task-concurrent-duplicate" });
  const request = continuation(bound, "one injection", "relay-concurrent-duplicate");
  let calls = 0;
  let release;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const invoke = async () => {
    calls += 1;
    markStarted();
    await new Promise((resolve) => { release = resolve; });
    return { thread_id: THREAD_A };
  };
  const sender = createCodexContinuationSender({ binding: bound, capabilities: { queue: true }, invoke });
  const first = sender.send(request);
  await started;
  await assert.rejects(() => sender.send(request), (error) => error.code === CODEX_CONTINUATION_ERRORS.DELIVERY_UNKNOWN);
  release();
  assert.equal((await first).status, "DISPATCHED");
  assert.equal(calls, 1);
  assert.equal((await sender.send(request)).status, "IDEMPOTENT");
});

test("binding and return hashes are deterministic", () => {
  const first = binding();
  const second = createCodexContinuationBinding({
    bound_at: BOUND_AT,
    repo_root: "D:\\Documents\\Codex\\repo",
    working_directory: WORK_A,
    thread_id: THREAD_A,
    task_id: "task-a",
    mission_id: "mission-1",
  });
  assert.equal(first.binding_id, second.binding_id);
  assert.equal(continuation(first, "prompt", "relay-1").return_id, continuation(second, "prompt", "relay-1").return_id);
});

test("semantic binding and prompt changes alter the parent-owned hashes", () => {
  const original = binding();
  assert.notEqual(original.binding_id, binding({ thread_id: THREAD_B }).binding_id);
  assert.notEqual(original.binding_id, binding({ task_id: "task-b" }).binding_id);
  assert.notEqual(continuation(original, "first", "relay-1").return_id, continuation(original, "first", "relay-2").return_id);
});

test("capability parsing prefers queue and thread-start parsing is strict", () => {
  const help = "Commands:\n  queue       Queue a message\n  resume      Resume a session\n";
  assert.deepEqual(parseCodexCapabilities(help), { queue: true, resume: true });
  assert.deepEqual(parseCodexCapabilities("Commands:\n  resume      Resume a session\n"), { queue: false, resume: true });
  assert.deepEqual(parseCodexThreadStartedIds(JSON.stringify({ type: "thread.started", thread_id: THREAD_A })), { ids: [THREAD_A], parse_errors: [] });
});
