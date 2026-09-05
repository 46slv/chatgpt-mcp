import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CODEX_PROMPT_PROTOCOL,
  FULL_RELAY_ERRORS,
  FULL_RELAY_STATES,
  LOCAL_RELAY_DECISION_PROTOCOL,
  canonicalJson,
  createBoundChatGPTTransport,
  createCodexPromptResponse,
  createConversationArbitrator,
  createFullRelayOrchestrator,
  createRelayRequest,
  createRelayStateStore,
  createLocalRelayDecision,
  hashJson,
  runFullRelayRound,
  sha256,
  validateCodexPromptResponse,
  validateLocalRelayDecision,
} from "./devexec-full-relay.mjs";
import {
  CODEX_CONTINUATION_ERRORS,
  createCodexContinuationBinding,
} from "./devexec-codex-continuation.mjs";
import { createCodexRuntimeBinding, CODEX_RUNTIME_ERRORS } from "./devexec-codex-runtime-binding.mjs";
import { createTaskChatBinding, createTaskChatRelayReport } from "./devexec-task-chat-binding.mjs";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-full-relay-test-"));
const BOUND_AT = "2026-09-02T10:00:00.000Z";
const THREAD_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const THREAD_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test.after(() => fs.rmSync(TEST_ROOT, { recursive: true, force: true }));

function newRoot(label = "case") {
  return fs.mkdtempSync(path.join(TEST_ROOT, `${label}-`));
}

function fixture({
  label = "case",
  mission_id = "mission-1",
  task_id = "task-a",
  conversation = "chat-a",
  thread_id = THREAD_A,
  queue = true,
  resume = false,
  stateDir = null,
  conversationStateDir = null,
} = {}) {
  const root = newRoot(label);
  const runtimeFile = path.join(root, "codex.exe");
  fs.writeFileSync(runtimeFile, `native runtime fixture ${label}\n`, "utf8");
  const chat_url = `https://chatgpt.com/c/${conversation}`;
  const chat = createTaskChatBinding({ mission_id, task_id, chat_url, conversation_id: conversation, source: "test-explicit", source_alias: `${task_id}-alias`, bound_at: BOUND_AT });
  const continuation = createCodexContinuationBinding({ mission_id, task_id, thread_id, working_directory: root, repo_root: root, bound_at: BOUND_AT });
  const runtime = createCodexRuntimeBinding({ executable_path: runtimeFile, launch_args: ["--bound-runtime"], version: "codex.exe 0.151.0-alpha.7.2-test", capabilities: { queue, resume }, bound_at: BOUND_AT, provenance: "native-test-fixture" });
  const report = createTaskChatRelayReport({ binding: chat, completion: "completed", situation: "deterministic test", status: "PASS" });
  return {
    root,
    stateDir: stateDir || path.join(root, "state"),
    conversationStateDir: conversationStateDir || path.join(root, "conversation-state"),
    chat,
    continuation,
    runtime,
    report,
  };
}

function envelopeFromPayload(payload, overrides = {}) {
  const payloadValue = JSON.parse(payload);
  return createCodexPromptResponse({
    mission_id: payloadValue.correlation.mission_id,
    task_id: payloadValue.correlation.task_id,
    relay_request_id: payloadValue.correlation.relay_request_id,
    report_sha256: payloadValue.correlation.report_sha256,
    decision: "CONTINUE",
    prompt: "exact ChatGPT prompt for the bound Codex thread",
    ...overrides,
  });
}

function relayAdapters({ response = envelopeFromPayload, local = null, chat = null, invoke = null, localSeen = null, chatSeen = null, codexSeen = null, chatgptTimeoutMs = 1000 } = {}) {
  const localModel = async (decisionInput) => {
    localSeen?.push({ ...decisionInput });
    if (local) return local(decisionInput);
    return createLocalRelayDecision({ request_id: decisionInput.request_id, payload_sha256: decisionInput.payload_sha256, action: decisionInput.action_expected });
  };
  const chatgptTransport = async (input) => {
    chatSeen?.push({ ...input });
    if (chat) return chat(input);
    return response(input.payload);
  };
  const codexInvoke = async (invocation) => {
    codexSeen?.push(invocation);
    if (invoke) return invoke(invocation);
    return { thread_id: invocation.thread_id };
  };
  return { localModel, chatgptTransport, invokeCodex: codexInvoke, chatgptTimeoutMs };
}

function orchestrator(fixtureValue, adapters = {}, options = {}) {
  return createFullRelayOrchestrator({
    taskChatBinding: fixtureValue.chat,
    codexContinuationBinding: fixtureValue.continuation,
    codexRuntimeBinding: fixtureValue.runtime,
    report: fixtureValue.report,
    stateDir: fixtureValue.stateDir,
    conversationStateDir: fixtureValue.conversationStateDir,
    ...adapters,
    ...options,
  });
}

test("Task A report -> exact Chat A -> correlated response -> exact thread A", async () => {
  const f = fixture();
  const localSeen = [];
  const chatSeen = [];
  const codexSeen = [];
  const o = orchestrator(f, relayAdapters({ localSeen, chatSeen, codexSeen }));
  const result = await o.run();
  assert.equal(result.status, FULL_RELAY_STATES.COMPLETED);
  assert.equal(result.thread_id, THREAD_A);
  assert.equal(codexSeen.length, 1);
  assert.equal(codexSeen[0].command, f.runtime.executable_path);
  assert.deepEqual(codexSeen[0].args, ["--bound-runtime", "queue", "--thread", THREAD_A, "--message", "exact ChatGPT prompt for the bound Codex thread"]);
  assert.equal(chatSeen[0].target.chat_url, f.chat.chat_url);
  assert.equal(chatSeen[0].target.conversation_id, f.chat.conversation_id);
  assert.deepEqual(localSeen.map((entry) => entry.action_expected), ["FORWARD_REPORT", "RETURN_CODEX_PROMPT"]);
  for (const entry of localSeen) {
    assert.equal(Object.hasOwn(entry, "payload"), false);
    assert.equal(Object.hasOwn(entry, "target"), false);
    assert.equal(Object.hasOwn(entry, "thread_id"), false);
    assert.equal(Object.hasOwn(entry, "command"), false);
  }
});

test("different exact conversations may send concurrently without cross-routing", async () => {
  const sharedConversationState = newRoot("different-conversations");
  const a = fixture({ label: "a", conversation: "chat-a-concurrent", stateDir: newRoot("a-state"), conversationStateDir: sharedConversationState });
  const b = fixture({ label: "b", task_id: "task-b", conversation: "chat-b-concurrent", thread_id: THREAD_B, stateDir: newRoot("b-state"), conversationStateDir: sharedConversationState });
  let active = 0;
  let maximum = 0;
  const seen = [];
  const chat = async (input) => {
    active += 1;
    maximum = Math.max(maximum, active);
    seen.push(input.target.conversation_id);
    await new Promise((resolve) => setTimeout(resolve, 25));
    active -= 1;
    return envelopeFromPayload(input.payload, { prompt: `prompt-${input.target.conversation_id}` });
  };
  const oa = orchestrator(a, relayAdapters({ chat }));
  const ob = orchestrator(b, relayAdapters({ chat }));
  const results = await Promise.all([oa.run(), ob.run()]);
  assert.equal(maximum, 2);
  assert.deepEqual(new Set(seen), new Set([a.chat.conversation_id, b.chat.conversation_id]));
  assert.deepEqual(new Set(results.map((result) => result.thread_id)), new Set([THREAD_A, THREAD_B]));
});

test("same exact conversation is single-flight across independent orchestrators", async () => {
  const conversationStateDir = newRoot("same-conversation");
  const a = fixture({ label: "a", conversation: "shared-conversation", stateDir: newRoot("a-state"), conversationStateDir });
  const b = fixture({ label: "b", task_id: "task-b", conversation: "shared-conversation", thread_id: THREAD_B, stateDir: newRoot("b-state"), conversationStateDir });
  let active = 0;
  let sendCount = 0;
  let releaseA;
  let startedA;
  const started = new Promise((resolve) => { startedA = resolve; });
  const chat = async (input) => {
    active += 1;
    sendCount += 1;
    assert.equal(active, 1);
    startedA();
    if (sendCount === 1) await new Promise((resolve) => { releaseA = resolve; });
    active -= 1;
    return envelopeFromPayload(input.payload, { prompt: `prompt-${input.target.conversation_id}-${input.task_id}` });
  };
  const oa = orchestrator(a, relayAdapters({ chat }));
  const ob = orchestrator(b, relayAdapters({ chat }));
  const pa = oa.run();
  await started;
  const waiting = await ob.run();
  assert.equal(waiting.status, FULL_RELAY_STATES.WAITING_FOR_CONVERSATION_SLOT);
  assert.equal(sendCount, 1);
  releaseA();
  assert.equal((await pa).status, FULL_RELAY_STATES.COMPLETED);
  const bResult = await ob.run();
  assert.equal(bResult.status, FULL_RELAY_STATES.COMPLETED);
  assert.equal(sendCount, 2);
});

test("waiting Task B retains its frozen binding after alias/default mutation", async () => {
  const conversationStateDir = newRoot("frozen-waiting");
  const a = fixture({ label: "a", conversation: "frozen-conversation", stateDir: newRoot("a-state"), conversationStateDir });
  const b = fixture({ label: "b", task_id: "task-b", conversation: "frozen-conversation", thread_id: THREAD_B, stateDir: newRoot("b-state"), conversationStateDir });
  let releaseA;
  let startedA;
  const started = new Promise((resolve) => { startedA = resolve; });
  const seenTargets = [];
  const chat = async (input) => {
    seenTargets.push(input.target);
    if (input.task_id === "task-a") {
      startedA();
      await new Promise((resolve) => { releaseA = resolve; });
    }
    return envelopeFromPayload(input.payload);
  };
  const oa = orchestrator(a, relayAdapters({ chat }));
  const ob = orchestrator(b, relayAdapters({ chat }));
  const pa = oa.run();
  await started;
  assert.equal((await ob.run()).status, FULL_RELAY_STATES.WAITING_FOR_CONVERSATION_SLOT);
  process.env.CHATGPT_MCP_CHAT_URL = "https://chatgpt.com/c/wrong-default";
  const mutableAlias = { target: "wrong-alias" };
  mutableAlias.target = "another-wrong-alias";
  releaseA();
  await pa;
  assert.equal((await ob.run()).status, FULL_RELAY_STATES.COMPLETED);
  assert.equal(seenTargets.at(-1).chat_url, b.chat.chat_url);
  assert.equal(seenTargets.at(-1).conversation_id, b.chat.conversation_id);
  delete process.env.CHATGPT_MCP_CHAT_URL;
});

test("a response for Task A cannot be consumed by Task B on the same conversation", async () => {
  const conversationStateDir = newRoot("response-isolation");
  const a = fixture({ label: "a", conversation: "response-shared", stateDir: newRoot("a-state"), conversationStateDir });
  const b = fixture({ label: "b", task_id: "task-b", conversation: "response-shared", thread_id: THREAD_B, stateDir: newRoot("b-state"), conversationStateDir });
  let bCodex = 0;
  const wrongForA = (payload) => {
    const value = JSON.parse(payload);
    return envelopeFromPayload(payload, { task_id: "task-b", prompt: "must not be consumed" });
  };
  const oa = orchestrator(a, relayAdapters({ response: wrongForA }));
  const rejected = await oa.run();
  assert.equal(rejected.status, FULL_RELAY_STATES.REJECTED);
  const ob = orchestrator(b, relayAdapters({ invoke: async (invocation) => { bCodex += 1; return { thread_id: invocation.thread_id }; } }));
  assert.equal((await ob.run()).status, FULL_RELAY_STATES.COMPLETED);
  assert.equal(bCodex, 1);
});

test("duplicate concurrent relay request produces at most one ChatGPT send", async () => {
  const f = fixture({ label: "duplicate-relay", stateDir: newRoot("duplicate-shared") });
  let sendCount = 0;
  let release;
  let startedSend;
  const started = new Promise((resolve) => { startedSend = resolve; });
  const chat = async (input) => {
    sendCount += 1;
    startedSend();
    await new Promise((resolve) => { release = resolve; });
    return envelopeFromPayload(input.payload);
  };
  const oa = orchestrator(f, relayAdapters({ chat }));
  const ob = orchestrator(f, relayAdapters({ chat }));
  const pa = oa.run();
  await started;
  const duplicate = await ob.run();
  assert.equal(duplicate.status, FULL_RELAY_STATES.CHATGPT_IN_FLIGHT);
  assert.equal(sendCount, 1);
  release();
  assert.equal((await pa).status, FULL_RELAY_STATES.COMPLETED);
});

test("duplicate concurrent Codex return produces at most one injection", async () => {
  const f = fixture({ label: "duplicate-codex", stateDir: newRoot("duplicate-codex-shared") });
  let injectCount = 0;
  let release;
  let startedInject;
  const started = new Promise((resolve) => { startedInject = resolve; });
  const invoke = async (invocation) => {
    injectCount += 1;
    startedInject();
    await new Promise((resolve) => { release = resolve; });
    return { thread_id: invocation.thread_id };
  };
  const oa = orchestrator(f, relayAdapters({ invoke }));
  const ob = orchestrator(f, relayAdapters({ invoke }));
  const pa = oa.run();
  await started;
  const duplicate = await ob.run();
  assert.equal(duplicate.status, FULL_RELAY_STATES.CODEX_IN_FLIGHT);
  assert.equal(injectCount, 1);
  release();
  assert.equal((await pa).status, FULL_RELAY_STATES.COMPLETED);
});

test("same relay identity with a changed report is a hard conflict", () => {
  const f = fixture({ label: "report-conflict", stateDir: newRoot("report-conflict-shared") });
  const first = orchestrator(f, relayAdapters({}));
  const changedReport = createTaskChatRelayReport({ binding: f.chat, completion: "changed", situation: "deterministic test", status: "PASS" });
  assert.throws(() => orchestrator({ ...f, report: changedReport }, relayAdapters({})), (error) => error.code === FULL_RELAY_ERRORS.REPORT_CONFLICT);
  assert.notEqual(first.request.report_sha256, createRelayRequest({ taskChatBinding: f.chat, codexContinuationBinding: f.continuation, codexRuntimeBinding: f.runtime, report: changedReport }).report_sha256);
});

test("wrong task, request, or report correlation is rejected", async () => {
  const variants = [
    { task_id: "other-task" },
    { relay_request_id: "sha256:" + "1".repeat(64) },
    { report_sha256: "sha256:" + "2".repeat(64) },
  ];
  for (const [index, overrides] of variants.entries()) {
    const f = fixture({ label: `correlation-${index}` });
    const o = orchestrator(f, relayAdapters({ response: (payload) => envelopeFromPayload(payload, overrides) }));
    const result = await o.run();
    assert.equal(result.status, FULL_RELAY_STATES.REJECTED);
    assert.equal(o.inspect().phase, FULL_RELAY_STATES.REJECTED);
  }
});

test("malformed and multiple response envelopes are rejected", async () => {
  for (const [index, response] of [[0, "not-json"], [1, [{}]]]) {
    const f = fixture({ label: `malformed-${index}` });
    const o = orchestrator(f, relayAdapters({ response: () => response }));
    const result = await o.run();
    assert.equal(result.status, FULL_RELAY_STATES.REJECTED);
    assert.equal(o.inspect().phase, FULL_RELAY_STATES.REJECTED);
  }
});

test("Local Model changing the payload hash rejects before external action", async () => {
  const f = fixture({ label: "local-hash" });
  let sends = 0;
  const o = orchestrator(f, relayAdapters({
    local: (input) => createLocalRelayDecision({ request_id: input.request_id, payload_sha256: sha256("different-payload"), action: input.action_expected }),
    chat: async () => { sends += 1; return null; },
  }));
  const result = await o.run();
  assert.equal(result.status, FULL_RELAY_STATES.REJECTED);
  assert.equal(sends, 0);
  assert.equal(o.inspect().error_code, FULL_RELAY_ERRORS.LOCAL_RELAY_HASH_MISMATCH);
});

test("Local Model target/thread/executable/command fields are rejected", async () => {
  const f = fixture({ label: "local-fields" });
  let sends = 0;
  const o = orchestrator(f, relayAdapters({
    local: (input) => ({ protocol: LOCAL_RELAY_DECISION_PROTOCOL, schema_version: 1, request_id: input.request_id, payload_sha256: input.payload_sha256, action: input.action_expected, target_url: f.chat.chat_url }),
    chat: async () => { sends += 1; return null; },
  }));
  const result = await o.run();
  assert.equal(result.status, FULL_RELAY_STATES.REJECTED);
  assert.equal(sends, 0);
});

test("ChatGPT timeout after IN_FLIGHT is DELIVERY_UNKNOWN and never retried", async () => {
  const f = fixture({ label: "chat-timeout", stateDir: newRoot("chat-timeout-shared") });
  let sends = 0;
  const o = orchestrator(f, relayAdapters({ chatgptTimeoutMs: 10, chat: async () => { sends += 1; await new Promise((resolve) => setTimeout(resolve, 100)); return null; } }));
  const first = await o.run();
  assert.equal(first.status, FULL_RELAY_STATES.DELIVERY_UNKNOWN);
  assert.equal(o.inspect().phase, FULL_RELAY_STATES.DELIVERY_UNKNOWN);
  assert.equal((await o.run()).status, FULL_RELAY_STATES.DELIVERY_UNKNOWN);
  assert.equal(sends, 1);
});

test("Codex timeout after injection start is DELIVERY_UNKNOWN and never reinjected", async () => {
  const f = fixture({ label: "codex-timeout", stateDir: newRoot("codex-timeout-shared") });
  let injects = 0;
  const o = orchestrator(f, relayAdapters({ invoke: async () => { injects += 1; throw new Error("process lost after queue start"); } }));
  const first = await o.run();
  assert.equal(first.status, FULL_RELAY_STATES.DELIVERY_UNKNOWN);
  assert.equal(o.inspect().phase, FULL_RELAY_STATES.DELIVERY_UNKNOWN);
  assert.equal((await o.run()).status, FULL_RELAY_STATES.DELIVERY_UNKNOWN);
  assert.equal(injects, 1);
  assert.equal(o.inspect().error_code, CODEX_CONTINUATION_ERRORS.DELIVERY_UNKNOWN);
});

test("runtime fingerprint drift immediately before return rejects without alternate PATH runtime", async () => {
  const f = fixture({ label: "runtime-drift" });
  let injects = 0;
  const o = orchestrator(f, relayAdapters({ invoke: async () => { injects += 1; return { thread_id: THREAD_A }; } }), {
    verifyRuntime: async () => { const error = new Error("runtime drift"); error.code = CODEX_RUNTIME_ERRORS.DRIFT; throw error; },
  });
  const result = await o.run();
  assert.equal(result.status, FULL_RELAY_STATES.REJECTED);
  assert.equal(injects, 0);
  assert.equal(o.inspect().error_code, CODEX_RUNTIME_ERRORS.DRIFT);
});

test("exact native queue path is used and resume/last/default fallbacks are absent", async () => {
  const f = fixture({ label: "queue-only" });
  const seen = [];
  const o = orchestrator(f, relayAdapters({ codexSeen: seen }));
  assert.equal((await o.run()).status, FULL_RELAY_STATES.COMPLETED);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].command, f.runtime.executable_path);
  assert.equal(seen[0].mode, "queue");
  assert.equal(seen[0].args.includes("resume"), false);
  assert.equal(seen[0].args.includes("--last"), false);
  assert.equal(seen[0].args.includes("--default"), false);
  assert.equal(seen[0].args.includes("current-chat"), false);
});

test("restart from persisted CHATGPT_IN_FLIGHT never sends again", async () => {
  const f = fixture({ label: "restart-chat", stateDir: newRoot("restart-chat-shared") });
  let sends = 0;
  const first = orchestrator(f, relayAdapters({ chat: async () => { sends += 1; return null; } }));
  const payload = first.request.report_payload;
  first.stateStore.update(first.request.relay_request_id, { phase: FULL_RELAY_STATES.CHATGPT_IN_FLIGHT, chatgpt_payload: payload, chatgpt_payload_sha256: first.request.report_payload_sha256 });
  const restarted = orchestrator(f, relayAdapters({ chat: async () => { sends += 1; return null; } }));
  const result = await restarted.run();
  assert.equal(result.status, FULL_RELAY_STATES.CHATGPT_IN_FLIGHT);
  assert.equal(sends, 0);
});

test("restart from persisted CODEX_IN_FLIGHT never injects again", async () => {
  const f = fixture({ label: "restart-codex", stateDir: newRoot("restart-codex-shared") });
  let injects = 0;
  const first = orchestrator(f, relayAdapters({ invoke: async () => { injects += 1; return { thread_id: THREAD_A }; } }));
  first.stateStore.update(first.request.relay_request_id, { phase: FULL_RELAY_STATES.CODEX_IN_FLIGHT });
  const restarted = orchestrator(f, relayAdapters({ invoke: async () => { injects += 1; return { thread_id: THREAD_A }; } }));
  const result = await restarted.run();
  assert.equal(result.status, FULL_RELAY_STATES.CODEX_IN_FLIGHT);
  assert.equal(injects, 0);
});

test("conversation arbitration is file-backed and refuses malformed lease takeover", () => {
  const dir = newRoot("lease-shape");
  const first = createConversationArbitrator({ stateDir: dir, owner_id: "process-a", now: () => BOUND_AT });
  const second = createConversationArbitrator({ stateDir: dir, owner_id: "process-b", now: () => BOUND_AT });
  const acquired = first.acquire({ conversation_id: "lease-conversation", task_id: "task-a", relay_request_id: "relay-a" });
  assert.equal(acquired.status, "ACQUIRED");
  const leaseFile = first.leasePathFor("lease-conversation");
  const persisted = JSON.parse(fs.readFileSync(leaseFile, "utf8"));
  assert.equal(persisted.key_sha256, sha256("lease-conversation"));
  assert.equal(Object.hasOwn(persisted, "conversation_id"), false);
  assert.equal(second.acquire({ conversation_id: "lease-conversation", task_id: "task-b", relay_request_id: "relay-b" }).status, "WAITING_FOR_CONVERSATION_SLOT");
  first.release(acquired.handle);
  const acquiredSecond = second.acquire({ conversation_id: "lease-conversation", task_id: "task-b", relay_request_id: "relay-b" });
  assert.equal(acquiredSecond.status, "ACQUIRED");
  second.release(acquiredSecond.handle);
  fs.writeFileSync(leaseFile, "{malformed", "utf8");
  assert.equal(second.acquire({ conversation_id: "lease-conversation", task_id: "task-c", relay_request_id: "relay-c" }).status, "LEASE_INVALID");
});

test("STOP and NEEDS_HUMAN are terminal and never inject a Codex prompt", async () => {
  for (const decision of ["STOP", "NEEDS_HUMAN"]) {
    const f = fixture({ label: `terminal-${decision}` });
    let injects = 0;
    const o = orchestrator(f, relayAdapters({ response: (payload) => envelopeFromPayload(payload, { decision, prompt: undefined }), invoke: async () => { injects += 1; return { thread_id: THREAD_A }; } }));
    const result = await o.run();
    assert.equal(result.status, decision === "STOP" ? FULL_RELAY_STATES.STOPPED : FULL_RELAY_STATES.NEEDS_HUMAN);
    assert.equal(injects, 0);
  }
});

test("COMPLETE is a distinct semantic terminal and never injects a Codex prompt", async () => {
  const f = fixture({ label: "terminal-COMPLETE" });
  let injects = 0;
  const o = orchestrator(f, relayAdapters({ response: (payload) => envelopeFromPayload(payload, { decision: "COMPLETE", prompt: undefined }), invoke: async () => { injects += 1; return { thread_id: THREAD_A }; } }));
  const result = await o.run();
  assert.equal(result.status, FULL_RELAY_STATES.COMPLETE);
  assert.equal(result.semantic_complete, true);
  assert.equal(injects, 0);
});

test("return-leg Local Model hash mutation rejects the exact prompt without Codex injection", async () => {
  const f = fixture({ label: "return-hash" });
  let calls = 0;
  const o = orchestrator(f, relayAdapters({ local: (input) => input.action_expected === "RETURN_CODEX_PROMPT"
    ? createLocalRelayDecision({ request_id: input.request_id, payload_sha256: sha256("wrong-prompt"), action: input.action_expected })
    : createLocalRelayDecision({ request_id: input.request_id, payload_sha256: input.payload_sha256, action: input.action_expected }), invoke: async () => { calls += 1; return { thread_id: THREAD_A }; } }));
  assert.equal((await o.run()).status, FULL_RELAY_STATES.REJECTED);
  assert.equal(calls, 0);
});

test("queue capability is required at admission; no resume fallback is selected", () => {
  const f = fixture({ label: "no-queue", queue: false, resume: true });
  assert.throws(() => orchestrator(f, relayAdapters({})), (error) => error.code === FULL_RELAY_ERRORS.CODEX_RUNTIME_CAPABILITY);
});

test("bound MCP adapter passes only the exact target URL and matching conversation ID", async () => {
  const f = fixture({ label: "mcp-adapter" });
  let call;
  const transport = createBoundChatGPTTransport({ taskChatBinding: f.chat, callTool: async (request, meta) => {
    call = { request, meta };
    return { content: [{ type: "text", text: JSON.stringify(createCodexPromptResponse({ mission_id: f.chat.mission_id, task_id: f.chat.task_id, relay_request_id: "relay", report_sha256: sha256("report"), decision: "STOP" })) }] };
  } });
  const envelope = await transport.send({ target: { binding_id: f.chat.binding_id, chat_url: f.chat.chat_url, conversation_id: f.chat.conversation_id }, payload: "payload", relay_request_id: "relay" });
  assert.equal(envelope.protocol, CODEX_PROMPT_PROTOCOL);
  assert.equal(call.request.arguments.target_url, f.chat.chat_url);
  assert.equal(call.request.arguments.expected_conversation_id, f.chat.conversation_id);
  assert.equal(Object.hasOwn(call.request.arguments, "targetAlias"), false);
});

test("bound MCP adapter unwraps the bundled chatgpt-mcp result without relaxing correlation", async () => {
  const f = fixture({ label: "mcp-wrapper" });
  const expected = createCodexPromptResponse({ mission_id: f.chat.mission_id, task_id: f.chat.task_id, relay_request_id: "relay-wrapper", report_sha256: sha256("report"), decision: "STOP" });
  const transport = createBoundChatGPTTransport({ taskChatBinding: f.chat, callTool: async () => ({ content: [{ type: "text", text: JSON.stringify({ response: JSON.stringify(expected), elapsed_seconds: 1, model: null, chat_id: f.chat.conversation_id, poll_count: 2 }) }] }) });
  const envelope = await transport.send({ target: { binding_id: f.chat.binding_id, chat_url: f.chat.chat_url, conversation_id: f.chat.conversation_id }, payload: "payload", relay_request_id: "relay-wrapper" });
  assert.deepEqual(envelope, expected);
});

test("deterministic hashes and strict envelopes reject unknown fields", () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(hashJson({ b: 2, a: 1 }), hashJson({ a: 1, b: 2 }));
  const decision = createLocalRelayDecision({ request_id: "relay", payload_sha256: sha256("payload"), action: "FORWARD_REPORT" });
  assert.equal(validateLocalRelayDecision(decision).action, "FORWARD_REPORT");
  assert.throws(() => validateLocalRelayDecision({ ...decision, command: "codex" }), (error) => error.code === FULL_RELAY_ERRORS.LOCAL_RELAY_INVALID);
  assert.throws(() => validateCodexPromptResponse({ protocol: CODEX_PROMPT_PROTOCOL, schema_version: 1, mission_id: "m", task_id: "t", relay_request_id: "r", report_sha256: sha256("x"), decision: "CONTINUE", prompt: "p", extra: true }), (error) => error.code === FULL_RELAY_ERRORS.CHATGPT_RESPONSE_INVALID);
});

test("runFullRelayRound performs one bounded round only", async () => {
  const f = fixture({ label: "one-round" });
  let chat = 0;
  let codex = 0;
  const result = await runFullRelayRound({ ...relayAdapters({ chat: async (input) => { chat += 1; return envelopeFromPayload(input.payload, { decision: "STOP" }); }, invoke: async () => { codex += 1; return { thread_id: THREAD_A }; } }), taskChatBinding: f.chat, codexContinuationBinding: f.continuation, codexRuntimeBinding: f.runtime, report: f.report, stateDir: f.stateDir, conversationStateDir: f.conversationStateDir });
  assert.equal(result.status, FULL_RELAY_STATES.STOPPED);
  assert.equal(chat, 1);
  assert.equal(codex, 0);
});
test("ChatGPT delivery ambiguity releases the conversation slot", async () => {
  const f = fixture({ label: "chat-ambiguous", conversation: "chat-ambiguous-slot" });
  const o = orchestrator(f, relayAdapters({ chat: async () => { throw new Error("bridge down"); } }));
  const result = await o.run();
  assert.equal(result.status, FULL_RELAY_STATES.DELIVERY_UNKNOWN);
  assert.equal(o.conversationArbitrator.inspect(f.chat.conversation_id), null);
});
test("Codex delivery ambiguity releases the conversation slot", async () => {
  const f = fixture({ label: "codex-ambiguous", conversation: "chat-codex-ambiguous-slot", task_id: "task-codex-ambiguous" });
  const failingSender = { send: async () => { throw Object.assign(new Error("queue ambiguous"), { code: CODEX_CONTINUATION_ERRORS.DELIVERY_UNKNOWN }); } };
  const o = orchestrator(f, { ...relayAdapters({}), codexSender: failingSender });
  const result = await o.run();
  assert.equal(result.status, FULL_RELAY_STATES.DELIVERY_UNKNOWN);
  assert.equal(o.conversationArbitrator.inspect(f.chat.conversation_id), null);
});
