import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CODEX_APP_SERVER_EVENTS,
  CLOSED_LOOP_ERRORS,
  CLOSED_LOOP_PHASES,
  CLOSED_LOOP_TERMINAL_PHASES,
  createClosedLoopOrchestrator,
  createClosedLoopOwnerLease,
  createClosedLoopStateStore,
  createCodexAppServerTurnObserver,
  parseCodexAppServerNotification,
  parseCodexAppServerNotifications,
} from "./devexec-closed-loop.mjs";
import {
  CODEX_PROMPT_DECISIONS,
  createCodexPromptResponse,
  createLocalRelayDecision,
} from "./devexec-full-relay.mjs";
import { createTaskChatBinding } from "./devexec-task-chat-binding.mjs";
import { createCodexContinuationBinding, createCodexContinuationReturn, createCodexContinuationSender } from "./devexec-codex-continuation.mjs";
import { createCodexRuntimeBinding } from "./devexec-codex-runtime-binding.mjs";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-closed-loop-test-"));
const BOUND_AT = "2026-09-02T10:00:00.000Z";
const THREAD_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const THREAD_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test.after(() => fs.rmSync(TEST_ROOT, { recursive: true, force: true }));

function newRoot(label = "case") {
  return fs.mkdtempSync(path.join(TEST_ROOT, `${label}-`));
}

function fixture({ label = "case", mission_id = "mission-1", task_id = "task-a", conversation = "chat-a", thread_id = THREAD_A, stateDir = null, conversationStateDir = null } = {}) {
  const root = newRoot(label);
  const runtimeFile = path.join(root, "codex.exe");
  fs.writeFileSync(runtimeFile, `native runtime fixture ${label}\n`, "utf8");
  const chat = createTaskChatBinding({ mission_id, task_id, chat_url: `https://chatgpt.com/c/${conversation}`, conversation_id: conversation, source: "test-explicit", source_alias: `${task_id}-alias`, bound_at: BOUND_AT });
  const continuation = createCodexContinuationBinding({ mission_id, task_id, thread_id, working_directory: root, repo_root: root, bound_at: BOUND_AT });
  const runtime = createCodexRuntimeBinding({ executable_path: runtimeFile, launch_args: ["--bound-runtime"], version: "codex.exe 0.151.0-alpha.7.2-test", capabilities: { queue: true, resume: true }, bound_at: BOUND_AT, provenance: "native-test-fixture" });
  return { root, stateDir: stateDir || path.join(root, "state"), conversationStateDir: conversationStateDir || path.join(root, "conversation-state"), chat, continuation, runtime };
}

function completion(thread_id, turn_id, message, sequence, user_prompt = null) {
  return { kind: "TURN_COMPLETED", thread_id, turn_id, turn_status: "completed", message, user_prompt, causal_proof: user_prompt === null ? "parent_observer" : "turn_prompt_exact", sequence };
}

function makeRoundHarness(f, decisions = ["CONTINUE", "CONTINUE", "CONTINUE", "STOP"], { observer = null, initial_turn_id = "turn-0", localSeen = [], chatSeen = [], codexSeen = [], observerOptions = {}, localRelayOverride = null, chatTransportOverride = null, codexSenderOverride = null, limitsOverride = null } = {}) {
  // One initial source plus one resulting completion for each CONTINUE.
  const completions = Array.from({ length: decisions.length + 1 }, (_, index) => completion(f.continuation.thread_id, `turn-${index}`, `Codex harmless result ${index}`, index + 1));
  let observationIndex = 0;
  const exactObserver = observer || {
    async wait(expectation) {
      assert.equal(expectation.thread_id, f.continuation.thread_id);
      if (observationIndex > 0) {
        assert.equal(expectation.after_turn_id, completions[observationIndex - 1].turn_id);
        assert.ok(expectation.after_sequence < completions[observationIndex].sequence);
      }
      const value = completions[observationIndex];
      observationIndex += 1;
      return value;
    },
    checkpoint() { return { sequence: observationIndex, completed_turn_ids: completions.slice(0, observationIndex).map((value) => value.turn_id) }; },
    close() {},
  };
  const localModel = async (input) => {
    localSeen.push({ ...input });
    return createLocalRelayDecision({ request_id: input.request_id, payload_sha256: input.payload_sha256, action: input.action_expected });
  };
  const chatgptTransport = async (input) => {
    chatSeen.push({ ...input });
    const payload = JSON.parse(input.payload);
    const decision = decisions[chatSeen.length - 1];
    const responseInput = {
      mission_id: payload.correlation.mission_id,
      task_id: payload.correlation.task_id,
      relay_request_id: payload.correlation.relay_request_id,
      report_sha256: payload.correlation.report_sha256,
      decision,
    };
    if (decision === CODEX_PROMPT_DECISIONS.CONTINUE) {
      responseInput.prompt = `continue-${chatSeen.length}`;
      responseInput.prompt_id = `chat-response-${chatSeen.length}`;
    }
    return createCodexPromptResponse(responseInput);
  };
  const codexSender = {
    async send(request) {
      codexSeen.push(request);
      return { status: "DISPATCHED", dispatched: true, mode: "queue", return_id: request.return_id, thread_id: f.continuation.thread_id, submission_id: `submission-${codexSeen.length}` };
    },
    inspect() { return null; },
  };
  const orchestrator = createClosedLoopOrchestrator({
    loop_id: `loop-${f.task_id || "task"}-${f.continuation.thread_id}`,
    taskChatBinding: f.chat,
    codexContinuationBinding: f.continuation,
    codexRuntimeBinding: f.runtime,
    stateDir: f.stateDir,
    conversationStateDir: f.conversationStateDir,
    observer: exactObserver,
    localRelay: localRelayOverride || localModel,
    chatgptTransport: chatTransportOverride || chatgptTransport,
    codexSender: codexSenderOverride || codexSender,
    limits: limitsOverride || { max_rounds: decisions.length, turn_timeout_ms: 2000, chatgpt_timeout_ms: 2000, local_relay_timeout_ms: 2000 },
    initial_turn_id,
    owner_id: `owner-${f.task_id || "task"}`,
    ...observerOptions,
  });
  return { orchestrator, observer: exactObserver, completions, localSeen, chatSeen, codexSeen, get observationIndex() { return observationIndex; } };
}

test("three CONTINUE rounds stay on one exact persisted thread and then STOP without injection", async () => {
  const f = fixture();
  const h = makeRoundHarness(f);
  const result = await h.orchestrator.run();
  assert.equal(result.status, CLOSED_LOOP_PHASES.STOPPED);
  assert.equal(result.thread_id, THREAD_A);
  assert.equal(result.history.length, 4);
  assert.deepEqual(result.history.map((entry) => entry.decision), ["CONTINUE", "CONTINUE", "CONTINUE", "STOP"]);
  assert.equal(h.chatSeen.length, 4);
  assert.equal(h.codexSeen.length, 3);
  assert.equal(new Set(h.codexSeen.map((entry) => entry.thread_id)).size, 1);
  assert.equal(new Set(result.history.map((entry) => entry.relay_request_id)).size, 4);
  assert.equal(h.localSeen.length, 7);
  assert.deepEqual(h.localSeen.map((entry) => entry.action_expected), ["FORWARD_REPORT", "RETURN_CODEX_PROMPT", "FORWARD_REPORT", "RETURN_CODEX_PROMPT", "FORWARD_REPORT", "RETURN_CODEX_PROMPT", "FORWARD_REPORT"]);
  assert.equal(result.history.at(-1).submission_id, null);
  assert.ok(CLOSED_LOOP_TERMINAL_PHASES.includes(result.status));
  h.orchestrator.close();
});

test("STOP and NEEDS_HUMAN terminate before another Codex injection", async () => {
  for (const decision of ["STOP", "NEEDS_HUMAN"]) {
    const f = fixture({ label: decision.toLowerCase(), task_id: decision.toLowerCase() });
    const h = makeRoundHarness(f, [decision]);
    const result = await h.orchestrator.run();
    assert.equal(result.status, decision === "STOP" ? CLOSED_LOOP_PHASES.STOPPED : CLOSED_LOOP_PHASES.NEEDS_HUMAN);
    assert.equal(h.codexSeen.length, 0);
    assert.equal(h.chatSeen.length, 1);
    assert.equal(h.localSeen.length, 1);
    h.orchestrator.close();
  }
});

test("max_rounds is a clean terminal state with no additional send", async () => {
  const f = fixture({ label: "max-rounds" });
  const h = makeRoundHarness(f, ["CONTINUE", "CONTINUE", "CONTINUE" ]);
  const result = await h.orchestrator.run();
  assert.equal(result.status, CLOSED_LOOP_PHASES.MAX_ROUNDS_REACHED);
  assert.equal(result.round_index, 3);
  assert.equal(h.chatSeen.length, 3);
  assert.equal(h.codexSeen.length, 3);
  h.orchestrator.close();
});

test("duplicate persisted run is idempotent and does not resend ChatGPT", async () => {
  const f = fixture({ label: "idempotent" });
  const h = makeRoundHarness(f, ["STOP"]);
  const first = await h.orchestrator.run();
  const second = await h.orchestrator.run();
  assert.equal(first.status, CLOSED_LOOP_PHASES.STOPPED);
  assert.equal(second.status, CLOSED_LOOP_PHASES.STOPPED);
  assert.equal(second.idempotent, true);
  assert.equal(h.chatSeen.length, 1);
  assert.equal(h.codexSeen.length, 0);
  h.orchestrator.close();
});

test("TaskChatBinding remains frozen when mutable defaults change mid-loop", async () => {
  const f = fixture({ label: "frozen-binding", conversation: "frozen-chat" });
  const h = makeRoundHarness(f, ["STOP"]);
  const prior = process.env.CHATGPT_MCP_CHAT_URL;
  try {
    process.env.CHATGPT_MCP_CHAT_URL = "https://chatgpt.com/c/unrelated-default";
    const result = await h.orchestrator.run();
    assert.equal(result.status, CLOSED_LOOP_PHASES.STOPPED);
    assert.equal(h.chatSeen[0].target.chat_url, f.chat.chat_url);
    assert.equal(h.chatSeen[0].target.conversation_id, f.chat.conversation_id);
  } finally {
    if (prior === undefined) delete process.env.CHATGPT_MCP_CHAT_URL;
    else process.env.CHATGPT_MCP_CHAT_URL = prior;
    h.orchestrator.close();
  }
});

test("two loops on different threads remain isolated", async () => {
  const sharedConversationState = newRoot("isolated-conversations");
  const a = fixture({ label: "a", task_id: "task-a", thread_id: THREAD_A, conversation: "conv-a", conversationStateDir: sharedConversationState });
  const b = fixture({ label: "b", task_id: "task-b", thread_id: THREAD_B, conversation: "conv-b", conversationStateDir: sharedConversationState });
  const ha = makeRoundHarness(a, ["STOP"]);
  const hb = makeRoundHarness(b, ["STOP"]);
  const results = await Promise.all([ha.orchestrator.run(), hb.orchestrator.run()]);
  assert.deepEqual(new Set(results.map((value) => value.thread_id)), new Set([THREAD_A, THREAD_B]));
  assert.equal(ha.chatSeen[0].target.conversation_id, "conv-a");
  assert.equal(hb.chatSeen[0].target.conversation_id, "conv-b");
  ha.orchestrator.close();
  hb.orchestrator.close();
});

test("owner lease prevents two processes from owning one loop/thread lineage", () => {
  const root = newRoot("owner");
  const first = createClosedLoopOwnerLease({ stateDir: root, owner_id: "process-a", now: () => BOUND_AT });
  const second = createClosedLoopOwnerLease({ stateDir: root, owner_id: "process-b", now: () => BOUND_AT });
  const acquired = first.acquire({ loop_id: "loop-owner", thread_id: THREAD_A });
  assert.equal(acquired.status, "ACQUIRED");
  const held = second.acquire({ loop_id: "loop-owner", thread_id: THREAD_A });
  assert.equal(held.status, "OWNER_HELD");
  assert.equal(second.acquire({ loop_id: "loop-owner", thread_id: THREAD_A }).status, "OWNER_HELD");
  first.release(acquired.handle);
});

test("state store rejects unknown fields and preserves immutable loop identity", () => {
  const f = fixture({ label: "state" });
  const store = createClosedLoopStateStore({ stateDir: f.stateDir, now: () => BOUND_AT });
  const state = store.create({ loop_id: "loop-state", mission_id: f.chat.mission_id, task_id: f.chat.task_id, task_chat_binding_id: f.chat.binding_id, conversation_id: f.chat.conversation_id, codex_continuation_binding_id: f.continuation.binding_id, codex_runtime_binding_id: f.runtime.binding_id, codex_runtime_fingerprint: f.runtime.runtime_fingerprint, thread_id: THREAD_A, limits: { max_rounds: 2 } });
  assert.equal(state.schema_version, 1);
  assert.throws(() => store.update("loop-state", { unexpected: true }), /Unknown loop state field/);
  assert.throws(() => store.create({ ...state, loop_id: "loop-state", thread_id: THREAD_B }), /state identity|persisted loop identity|state.loop_id|thread_id/);
});

test("wrong-thread turn/completed is ignored and never consumed", () => {
  const event = { method: CODEX_APP_SERVER_EVENTS.TURN_COMPLETED, params: { threadId: THREAD_B, turn: { id: "turn-b", status: "completed", items: [{ type: "agentMessage", text: "wrong" }] } } };
  const parsed = parseCodexAppServerNotification(event, { thread_id: THREAD_A, sequence: 2 });
  assert.equal(parsed.kind, "IGNORED");
  assert.equal(parsed.reason, "WRONG_THREAD");
  const stream = parseCodexAppServerNotifications([event, { method: CODEX_APP_SERVER_EVENTS.TURN_COMPLETED, params: { threadId: THREAD_A, turn: { id: "turn-a", status: "completed", items: [{ type: "agentMessage", text: "right" }] } } }], { thread_id: THREAD_A });
  assert.equal(stream.events.filter((entry) => entry.kind === "TURN_COMPLETED").length, 1);
  assert.equal(stream.events.find((entry) => entry.kind === "TURN_COMPLETED").turn_id, "turn-a");
});

test("wrong turn status, prior turn, and prompt causality are rejected", async () => {
  const f = fixture({ label: "causality" });
  const wrongObserver = { async wait() { return completion(THREAD_B, "turn-wrong", "wrong", 1); }, checkpoint() { return { sequence: 0 }; }, close() {} };
  const h = makeRoundHarness(f, ["STOP"], { observer: wrongObserver });
  const wrong = await h.orchestrator.run();
  assert.equal(wrong.status, CLOSED_LOOP_PHASES.REJECTED);
  assert.equal(h.chatSeen.length, 0);
  h.orchestrator.close();

  const f2 = fixture({ label: "prompt-causality" });
  let waitCount = 0;
  const causalObserver = {
    async wait(input) {
      waitCount += 1;
      assert.equal(input.thread_id, THREAD_A);
      if (waitCount === 1) return completion(THREAD_A, "turn-0", "Codex harmless result 0", 1);
      return { ...completion(THREAD_A, "turn-1", "Codex harmless result 1", 2, "not-the-queued-prompt"), causal_proof: "turn_prompt_exact" };
    },
    checkpoint() { return { sequence: waitCount }; },
    close() {},
  };
  const h2 = makeRoundHarness(f2, ["CONTINUE", "STOP"], { observer: causalObserver });
  const result = await h2.orchestrator.run();
  assert.equal(result.status, CLOSED_LOOP_PHASES.REJECTED);
  assert.equal(h2.codexSeen.length, 1);
  h2.orchestrator.close();
});

test("native observer resumes one exact thread, ignores unrelated events, and is idempotent after reconnect", async () => {
  const f = fixture({ label: "observer" });
  const sent = [];
  const connections = [];
  const observer = createCodexAppServerTurnObserver({
    continuationBinding: f.continuation,
    runtimeBinding: f.runtime,
    connectionFactory({ onNotification }) {
      const pending = new Map();
      const connection = {
        request(method, params) {
          sent.push({ method, params });
          if (method === "initialize") return Promise.resolve({});
          if (method === "thread/resume") return Promise.resolve({ thread: { id: THREAD_A, turns: [{ id: "turn-0", status: "completed", items: [{ type: "userMessage", content: [{ type: "text", text: "initial" }] }, { type: "agentMessage", phase: "final_answer", text: "initial result" }] }] } });
          return Promise.resolve({});
        },
        notify(method, params) { sent.push({ method, params, notification: true }); },
        close() { pending.clear(); },
        emit(value) { onNotification(value); },
      };
      connections.push(connection);
      return connection;
    },
  });
  const first = await observer.wait({ thread_id: THREAD_A, turn_id: "turn-0", timeout_ms: 1000 });
  assert.equal(first.turn_id, "turn-0");
  const duplicate = await observer.wait({ thread_id: THREAD_A, turn_id: "turn-0", timeout_ms: 1000 });
  assert.equal(duplicate.idempotent, true);
  assert.equal(sent.filter((entry) => entry.method === "thread/resume").length, 1);
  observer.reconnect();
  const secondConnection = connections.at(-1);
  secondConnection.emit({ method: CODEX_APP_SERVER_EVENTS.TURN_COMPLETED, params: { threadId: THREAD_B, turn: { id: "turn-b", status: "completed", items: [{ type: "agentMessage", text: "wrong" }] } } });
  secondConnection.emit({ method: CODEX_APP_SERVER_EVENTS.TURN_COMPLETED, params: { threadId: THREAD_A, turn: { id: "turn-1", status: "completed", items: [{ type: "userMessage", content: [{ type: "text", text: "queued" }] }, { type: "agentMessage", phase: "final_answer", text: "next result" }] } } });
  const next = await observer.wait({ thread_id: THREAD_A, after_turn_id: "turn-0", prompt: "queued", after_sequence: 0, timeout_ms: 1000 });
  assert.equal(next.turn_id, "turn-1");
  observer.close();
});

test("compact observer hydrates one exact turn through bounded pagination", async () => {
  const f = fixture({ label: "observer-compact" });
  const sent = [];
  const observer = createCodexAppServerTurnObserver({
    continuationBinding: f.continuation,
    runtimeBinding: f.runtime,
    compactHistory: true,
    historyPageSize: 2,
    historyPageLimit: 2,
    itemPageSize: 8,
    connectionFactory({ onNotification }) {
      return {
        request: async (method, params) => {
          sent.push({ method, params });
          if (method === "initialize") return {};
          if (method === "thread/resume") return { thread: { id: THREAD_A, turns: [] } };
          if (method === "thread/turns/list") return { data: [{ id: "turn-0", status: "completed", items: [] }], nextCursor: null };
          if (method === "thread/items/list") return { data: [
            { turnId: "turn-0", item: { type: "userMessage", id: "user-0", content: [{ type: "text", text: "initial" }] } },
            { turnId: "turn-0", item: { type: "agentMessage", id: "agent-0", phase: "final_answer", text: "initial result" } },
          ], nextCursor: null };
          return {};
        },
        notify() {},
        close() {},
        emit: onNotification,
      };
    },
  });
  const result = await observer.wait({ thread_id: THREAD_A, turn_id: "turn-0", timeout_ms: 1000 });
  assert.equal(result.message, "initial result");
  assert.equal(result.user_prompt, "initial");
  assert.equal(sent.find((entry) => entry.method === "thread/resume").params.excludeTurns, true);
  assert.equal(sent.filter((entry) => entry.method === "thread/turns/list").length, 1);
  assert.equal(sent.filter((entry) => entry.method === "thread/items/list").length, 2);
  observer.close();
});

test("active-writer admission falls back to bounded exact durable-history polling", async () => {
  const f = fixture({ label: "observer-active-writer" });
  const sent = [];
  let turnsCall = 0;
  const observer = createCodexAppServerTurnObserver({
    continuationBinding: f.continuation,
    runtimeBinding: f.runtime,
    compactHistory: true,
    historyPageSize: 4,
    historyPageLimit: 2,
    itemPageSize: 8,
    connectionFactory() {
      return {
        request: async (method, params) => {
          sent.push({ method, params });
          if (method === "initialize") return {};
          if (method === "thread/resume") {
            const error = new Error("Codex app-server request failed.");
            error.cause = { message: `thread-store conflict: thread ${THREAD_A} already has an active writer` };
            throw error;
          }
          if (method === "thread/turns/list") {
            turnsCall += 1;
            const entries = turnsCall === 1
              ? [{ id: "turn-0", status: "completed" }]
              : [{ id: "turn-0", status: "completed" }, { id: "turn-1", status: "completed", submissionId: "submission-1" }];
            return { threadId: THREAD_A, data: entries, nextCursor: null };
          }
          if (method === "thread/items/list") {
            const turnId = params.turnId;
            const items = turnId === "turn-0"
              ? [{ type: "userMessage", id: "user-0", content: [{ type: "text", text: "initial" }] }, { type: "agentMessage", id: "agent-0", phase: "final_answer", text: "initial result" }]
              : [{ type: "userMessage", id: "user-1", content: [{ type: "text", text: "queued prompt" }] }, { type: "agentMessage", id: "agent-1", phase: "final_answer", text: "queued result" }];
            return { threadId: THREAD_A, data: items.map((item) => ({ turnId, item })), nextCursor: null };
          }
          return {};
        },
        notify() {},
        close() {},
      };
    },
  });
  const initial = await observer.wait({ thread_id: THREAD_A, turn_id: "turn-0", timeout_ms: 1000 });
  assert.equal(initial.turn_id, "turn-0");
  assert.equal(initial.message, "initial result");
  const next = await observer.wait({ thread_id: THREAD_A, after_turn_id: "turn-0", prompt: "queued prompt", submission_id: "submission-1", timeout_ms: 1000 });
  assert.equal(next.turn_id, "turn-1");
  assert.equal(next.submission_id, "submission-1");
  assert.equal(next.source, "durable-history");
  assert.equal(observer.inspect().read_only, true);
  assert.equal(sent.filter((entry) => entry.method === "thread/resume").length, 1);
  assert.ok(sent.filter((entry) => entry.method === "thread/turns/list").every((entry) => entry.params.threadId === THREAD_A));
  assert.ok(sent.filter((entry) => entry.method === "thread/items/list").every((entry) => entry.params.threadId === THREAD_A));
  observer.close();
});

test("observer rejects notifications without exact thread identity", () => {
  assert.throws(() => parseCodexAppServerNotification({ method: CODEX_APP_SERVER_EVENTS.TURN_COMPLETED, params: { turn: { id: "turn-a", status: "completed", items: [{ type: "agentMessage", text: "missing thread" }] } } }, { thread_id: THREAD_A }), /exact threadId/);
});

test("observer uses bound absolute runtime and app-server stdio only", () => {
  const f = fixture({ label: "observer-command" });
  let observed;
  const observer = createCodexAppServerTurnObserver({ continuationBinding: f.continuation, runtimeBinding: f.runtime, connectionFactory(options) { observed = options; return { request: async () => ({ thread: { id: THREAD_A, turns: [] } }), notify() {}, close() {} }; } });
  return observer.wait({ thread_id: THREAD_A, timeout_ms: 20 }).catch((error) => {
    assert.equal(error.code, "CLOSED_LOOP_OBSERVER_TIMEOUT");
    assert.equal(observed.command, f.runtime.executable_path);
    assert.deepEqual(observed.args, ["--bound-runtime", "app-server", "--stdio"]);
    assert.equal(observed.cwd, f.continuation.working_directory);
    assert.equal(observed.args.includes("--last"), false);
    observer.close();
  });
});

test("restart from Full Relay CHATGPT_IN_FLIGHT is DELIVERY_UNKNOWN and never resends", async () => {
  const f = fixture({ label: "chat-in-flight" });
  let chatCalls = 0;
  const h = makeRoundHarness(f, ["STOP"], { chatTransportOverride: async () => { chatCalls += 1; throw new Error("simulated transport disconnect after send began"); } });
  const first = await h.orchestrator.run();
  const second = await h.orchestrator.run();
  assert.equal(first.status, CLOSED_LOOP_PHASES.DELIVERY_UNKNOWN);
  assert.equal(second.status, CLOSED_LOOP_PHASES.DELIVERY_UNKNOWN);
  assert.equal(chatCalls, 1);
  assert.equal(h.codexSeen.length, 0);
  h.orchestrator.close();
});

test("restart from Full Relay CODEX_IN_FLIGHT is DELIVERY_UNKNOWN and never reinjects", async () => {
  const f = fixture({ label: "codex-in-flight" });
  let sendCalls = 0;
  let inFlight = false;
  const sender = {
    async send() { sendCalls += 1; inFlight = true; throw new Error("simulated queue disconnect after invocation"); },
    inspect() { return inFlight ? { status: "IN_FLIGHT", error_code: null } : null; },
  };
  const h = makeRoundHarness(f, ["CONTINUE"], { codexSenderOverride: sender });
  const first = await h.orchestrator.run();
  const second = await h.orchestrator.run();
  assert.equal(first.status, CLOSED_LOOP_PHASES.DELIVERY_UNKNOWN);
  assert.equal(second.status, CLOSED_LOOP_PHASES.DELIVERY_UNKNOWN);
  assert.equal(sendCalls, 1);
  h.orchestrator.close();
});

test("runtime fingerprint drift between rounds stops before the next relay", async () => {
  const f = fixture({ label: "runtime-drift" });
  let sendCalls = 0;
  const sender = {
    async send(request) { sendCalls += 1; fs.appendFileSync(f.runtime.executable_path, "drift\n", "utf8"); return { status: "DISPATCHED", dispatched: true, mode: "queue", return_id: request.return_id, thread_id: THREAD_A, submission_id: "submission-1" }; },
    inspect() { return null; },
  };
  const h = makeRoundHarness(f, ["CONTINUE", "STOP"], { codexSenderOverride: sender });
  const result = await h.orchestrator.run();
  assert.equal(result.status, CLOSED_LOOP_PHASES.REJECTED);
  assert.equal(sendCalls, 1);
  assert.equal(h.chatSeen.length, 1);
  h.orchestrator.close();
});

test("same conversation preserves CGL003 single-flight while a second loop waits", async () => {
  const conversationStateDir = newRoot("controller-single-flight");
  const a = fixture({ label: "a-flight", task_id: "task-a-flight", conversation: "shared-controller", thread_id: THREAD_A, conversationStateDir });
  const b = fixture({ label: "b-flight", task_id: "task-b-flight", conversation: "shared-controller", thread_id: THREAD_B, conversationStateDir });
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const chat = async (input) => { started(); await new Promise((resolve) => { release = resolve; }); const payload = JSON.parse(input.payload); return createCodexPromptResponse({ mission_id: payload.correlation.mission_id, task_id: payload.correlation.task_id, relay_request_id: payload.correlation.relay_request_id, report_sha256: payload.correlation.report_sha256, decision: "STOP" }); };
  const ha = makeRoundHarness(a, ["STOP"], { chatTransportOverride: chat });
  const hb = makeRoundHarness(b, ["STOP"], { chatTransportOverride: chat });
  const pa = ha.orchestrator.run();
  await startedPromise;
  const waiting = await hb.orchestrator.run();
  assert.equal(waiting.status, "RELAY_IN_PROGRESS");
  assert.equal(waiting.waiting, true);
  release();
  assert.equal((await pa).status, CLOSED_LOOP_PHASES.STOPPED);
  ha.orchestrator.close();
  hb.orchestrator.close();
});

test("compact turn/completed can use exact preceding item events without arrival-order guessing", async () => {
  const f = fixture({ label: "compact-events" });
  let connection;
  const observer = createCodexAppServerTurnObserver({ continuationBinding: f.continuation, runtimeBinding: f.runtime, connectionFactory({ onNotification }) {
    connection = { request: async (method) => method === "thread/resume" ? { thread: { id: THREAD_A, turns: [] } } : {}, notify() {}, close() {}, emit: onNotification };
    return connection;
  } });
  const firstPromise = observer.wait({ thread_id: THREAD_A, turn_id: "turn-0", timeout_ms: 500 });
  await Promise.resolve();
  connection.emit({ method: CODEX_APP_SERVER_EVENTS.ITEM_COMPLETED, params: { threadId: THREAD_A, turnId: "turn-0", item: { type: "userMessage", content: [{ type: "text", text: "initial" }] } } });
  connection.emit({ method: CODEX_APP_SERVER_EVENTS.ITEM_COMPLETED, params: { threadId: THREAD_A, turnId: "turn-0", item: { type: "agentMessage", phase: "final_answer", text: "compact result" } } });
  connection.emit({ method: CODEX_APP_SERVER_EVENTS.TURN_COMPLETED, params: { threadId: THREAD_A, turn: { id: "turn-0", status: "completed", items: [] } } });
  assert.equal((await firstPromise).message, "compact result");
  observer.close();
});

test("queue-only continuation result carries the native submission identity without changing legacy validation", async () => {
  const f = fixture({ label: "submission-id" });
  const sender = createCodexContinuationSender({ binding: f.continuation, runtime: f.runtime, required_mode: "queue", require_queue: true, invoke: async () => ({ stdout: `Queued message 11111111-1111-4111-8111-111111111111 for thread ${THREAD_A}.\n`, exitCode: 0 }) });
  const request = createCodexContinuationReturn({ binding: f.continuation, prompt: "submission probe", response_id: "response-submission" });
  const result = await sender.send(request);
  assert.equal(result.mode, "queue");
  assert.equal(result.thread_id, THREAD_A);
  assert.equal(result.submission_id, "11111111-1111-4111-8111-111111111111");
});
