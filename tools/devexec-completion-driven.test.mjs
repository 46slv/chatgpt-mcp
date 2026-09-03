import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CLOSED_LOOP_MODES,
  CLOSED_LOOP_PHASES,
  createClosedLoopOrchestrator,
} from "./devexec-closed-loop.mjs";
import {
  CODEX_PROMPT_DECISIONS,
  createCodexPromptResponse,
  createLocalRelayDecision,
  hashJson,
} from "./devexec-full-relay.mjs";
import { createTaskChatBinding } from "./devexec-task-chat-binding.mjs";
import { createCodexContinuationBinding } from "./devexec-codex-continuation.mjs";
import { createCodexRuntimeBinding } from "./devexec-codex-runtime-binding.mjs";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-completion-driven-"));
const THREAD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INITIAL_TURN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function fixture(label) {
  const root = fs.mkdtempSync(path.join(ROOT, `${label}-`));
  const executable = path.join(root, "codex.exe");
  fs.writeFileSync(executable, `runtime-${label}\n`, "utf8");
  const chat = createTaskChatBinding({
    mission_id: `mission-${label}`,
    task_id: `task-${label}`,
    chat_url: `https://chatgpt.com/g/g-p-${label}/c/conversation-${label}`,
    bound_at: "2026-09-03T00:00:00.000Z",
  });
  const continuation = createCodexContinuationBinding({
    mission_id: chat.mission_id,
    task_id: chat.task_id,
    thread_id: THREAD,
    working_directory: root,
    repo_root: root,
    bound_at: "2026-09-03T00:00:00.000Z",
  });
  const runtime = createCodexRuntimeBinding({
    executable_path: executable,
    launch_args: ["--bound-runtime"],
    version: "codex-test-runtime 1.0",
    capabilities: { queue: true, resume: true },
    bound_at: "2026-09-03T00:00:00.000Z",
    provenance: "completion-driven-test",
  });
  return { root, chat, continuation, runtime };
}

function harness(f, decisions, {
  mode = CLOSED_LOOP_MODES.COMPLETION_DRIVEN,
  max_rounds = null,
  report_context = {},
  completionMessages = [],
} = {}) {
  const chats = [];
  const relays = [];
  const queues = [];
  let observation = 0;
  const observer = {
    async wait(expected) {
      const turn = observation === 0 ? INITIAL_TURN : `turn-${observation}`;
      if (observation > 0) {
        assert.equal(expected.after_turn_id, observation === 1 ? INITIAL_TURN : `turn-${observation - 1}`);
        assert.equal(expected.prompt, `next task ${observation}`);
      }
      const value = {
        kind: "TURN_COMPLETED",
        thread_id: THREAD,
        turn_id: turn,
        turn_status: "completed",
        message: completionMessages[observation] || "Codex says done (self-report only).",
      };
      if (observation > 0) value.user_prompt = expected.prompt;
      observation += 1;
      return value;
    },
    checkpoint() { return { sequence: observation }; },
    close() {},
  };
  const localRelay = {
    async decide(input) {
      relays.push({ ...input });
      return createLocalRelayDecision({ request_id: input.request_id, payload_sha256: input.payload_sha256, action: input.action_expected });
    },
  };
  const chatgptTransport = {
    async send(input) {
      chats.push({ ...input });
      const payload = JSON.parse(input.payload);
      const decision = decisions[chats.length - 1];
      const response = {
        mission_id: payload.correlation.mission_id,
        task_id: payload.correlation.task_id,
        relay_request_id: payload.correlation.relay_request_id,
        report_sha256: payload.correlation.report_sha256,
        decision,
      };
      if (decision === CODEX_PROMPT_DECISIONS.CONTINUE) {
        response.prompt = `next task ${chats.length}`;
        response.prompt_id = `supervisor-response-${chats.length}`;
      }
      return createCodexPromptResponse(response);
    },
  };
  const codexSender = {
    async send(request) {
      queues.push({ ...request });
      return {
        status: "DISPATCHED",
        dispatched: true,
        mode: "queue",
        return_id: request.return_id,
        thread_id: THREAD,
        submission_id: `submission-${queues.length}`,
      };
    },
    inspect() { return null; },
  };
  const orchestrator = createClosedLoopOrchestrator({
    loop_id: `loop-${f.chat.task_id}`,
    taskChatBinding: f.chat,
    codexContinuationBinding: f.continuation,
    codexRuntimeBinding: f.runtime,
    stateDir: path.join(f.root, "state"),
    conversationStateDir: path.join(f.root, "conversation"),
    observer,
    localRelay,
    chatgptTransport,
    codexSender,
    execution_mode: mode,
    limits: { mode, max_rounds, turn_timeout_ms: 2000, chatgpt_timeout_ms: 2000, local_relay_timeout_ms: 2000 },
    initial_turn_id: INITIAL_TURN,
    report_context: {
      goal: "Complete the bounded feature goal.",
      current_task: "Implement the next exact task from the Supervisor.",
      branch: "automation/test-completion-driven",
      head: "0123456789abcdef0123456789abcdef01234567",
      changed_files: ["src/example.mjs"],
      validation: { tests: ["node --test"], result: "PASS" },
      diff_evidence: { paths: ["src/example.mjs"], stat: "1 file changed" },
      unresolved_blockers: [],
      parent_verifiable_evidence: { evidence_origin: "test-parent", verified: true },
      ...report_context,
    },
    owner_id: `owner-${f.chat.task_id}`,
  });
  return { orchestrator, observer, chats, relays, queues };
}

test("COMPLETE is semantic terminal and never queues", async () => {
  const f = fixture("complete");
  const h = harness(f, ["COMPLETE"]);
  const result = await h.orchestrator.run();
  assert.equal(result.status, CLOSED_LOOP_PHASES.COMPLETE);
  assert.equal(result.semantic_terminal, true);
  assert.equal(result.supervisor_decision, "COMPLETE");
  assert.equal(h.queues.length, 0);
  assert.deepEqual(result.history.map((entry) => entry.decision), ["COMPLETE"]);
  assert.equal(result.history[0].next_task_sha256, null);
  assert.equal(result.history[0].same_thread_proof, "exact_bound_thread");
  assert.equal(h.relays.length, 1);
  const reportPayload = JSON.parse(h.chats[0].payload).report;
  assert.equal(reportPayload.goal, "Complete the bounded feature goal.");
  assert.deepEqual(reportPayload.changed_files, ["src/example.mjs"]);
  assert.equal(reportPayload.parent_verifiable_evidence.verified, true);
  h.orchestrator.close();
});

test("NEEDS_HUMAN is a distinct terminal and never queues", async () => {
  const f = fixture("needs-human");
  const h = harness(f, ["NEEDS_HUMAN"]);
  const result = await h.orchestrator.run();
  assert.equal(result.status, CLOSED_LOOP_PHASES.NEEDS_HUMAN);
  assert.equal(result.semantic_terminal, false);
  assert.equal(result.supervisor_decision, "NEEDS_HUMAN");
  assert.equal(h.queues.length, 0);
  h.orchestrator.close();
});

test("multiple CONTINUE decisions keep exact same-thread queue and persist cycle evidence", async () => {
  const f = fixture("multi");
  const h = harness(f, ["CONTINUE", "CONTINUE", "COMPLETE"], { completionMessages: ["done", "done", "done"] });
  const result = await h.orchestrator.run();
  assert.equal(result.status, CLOSED_LOOP_PHASES.COMPLETE);
  assert.equal(result.history.length, 3);
  assert.deepEqual(result.history.map((entry) => entry.decision), ["CONTINUE", "CONTINUE", "COMPLETE"]);
  assert.equal(h.queues.length, 2);
  assert.deepEqual(h.queues.map((request) => request.thread_id), [THREAD, THREAD]);
  assert.ok(result.history.every((entry) => typeof entry.cycle_id === "string" && entry.cycle_id.startsWith("sha256:")));
  assert.ok(result.history.every((entry) => typeof entry.report_sha256 === "string" && entry.report_sha256.startsWith("sha256:")));
  assert.ok(result.history.slice(0, 2).every((entry) => entry.next_task_sha256 === `sha256:${crypto.createHash("sha256").update(`next task ${result.history.indexOf(entry) + 1}`, "utf8").digest("hex")}`));
  assert.ok(result.history.slice(0, 2).every((entry) => entry.queue_submission_id === entry.submission_id));
  assert.ok(result.history.slice(0, 2).every((entry) => entry.same_thread_proof === "exact_bound_thread"));
  h.orchestrator.close();
});

test("Codex self-reporting done does not bypass Supervisor CONTINUE", async () => {
  const f = fixture("self-report");
  const h = harness(f, ["CONTINUE", "COMPLETE"], { completionMessages: ["done", "done"] });
  const result = await h.orchestrator.run();
  assert.equal(result.status, CLOSED_LOOP_PHASES.COMPLETE);
  assert.equal(h.chats.length, 2);
  assert.equal(h.queues.length, 1);
  assert.deepEqual(result.history.map((entry) => entry.decision), ["CONTINUE", "COMPLETE"]);
  h.orchestrator.close();
});

test("completion-driven mode does not use max_rounds as a normal terminal", async () => {
  const f = fixture("no-round-cap");
  const h = harness(f, ["CONTINUE", "CONTINUE", "CONTINUE", "COMPLETE"], { max_rounds: 1 });
  const result = await h.orchestrator.run();
  assert.equal(result.status, CLOSED_LOOP_PHASES.COMPLETE);
  assert.notEqual(result.status, CLOSED_LOOP_PHASES.MAX_ROUNDS_REACHED);
  assert.equal(h.chats.length, 4);
  assert.equal(h.queues.length, 3);
  h.orchestrator.close();
});

test("completion-driven safety_max_rounds is an explicit parent terminal", async () => {
  const f = fixture("safety-cap");
  const h = harness(f, ["CONTINUE", "CONTINUE", "CONTINUE"], { max_rounds: 1 });
  let cappedChats = 0;
  let cappedQueues = 0;
  // The safety cap is intentionally separate from max_rounds.  Two exact
  // turns are allowed here (rounds 0 and 1); the parent then stops before a
  // third Supervisor report rather than silently treating max_rounds as the
  // completion-driven terminal.
  h.orchestrator.close();
  const capped = createClosedLoopOrchestrator({
    loop_id: `loop-${f.chat.task_id}-safety`,
    taskChatBinding: f.chat,
    codexContinuationBinding: f.continuation,
    codexRuntimeBinding: f.runtime,
    stateDir: path.join(f.root, "safety-state"),
    conversationStateDir: path.join(f.root, "safety-conversation"),
    observer: h.observer,
    localRelay: { decide: async (input) => createLocalRelayDecision({ request_id: input.request_id, payload_sha256: input.payload_sha256, action: input.action_expected }) },
    chatgptTransport: {
      async send(input) {
        const payload = JSON.parse(input.payload);
        const response = {
          mission_id: payload.correlation.mission_id,
          task_id: payload.correlation.task_id,
          relay_request_id: payload.correlation.relay_request_id,
          report_sha256: payload.correlation.report_sha256,
          decision: "CONTINUE",
          prompt: `next task ${cappedChats + 1}`,
        };
        cappedChats += 1;
        return createCodexPromptResponse(response);
      },
    },
    codexSender: {
      async send(request) {
        cappedQueues += 1;
        return { status: "DISPATCHED", dispatched: true, mode: "queue", return_id: request.return_id, thread_id: THREAD, submission_id: `safety-submission-${cappedQueues}` };
      },
      inspect() { return null; },
    },
    execution_mode: CLOSED_LOOP_MODES.COMPLETION_DRIVEN,
    limits: { mode: CLOSED_LOOP_MODES.COMPLETION_DRIVEN, max_rounds: 1, safety_max_rounds: 2, turn_timeout_ms: 2000, chatgpt_timeout_ms: 2000, local_relay_timeout_ms: 2000 },
    initial_turn_id: INITIAL_TURN,
    owner_id: `owner-${f.chat.task_id}-safety`,
  });
  const result = await capped.run();
  assert.equal(result.status, CLOSED_LOOP_PHASES.SAFETY_LIMIT_REACHED);
  assert.equal(result.execution_mode, CLOSED_LOOP_MODES.COMPLETION_DRIVEN);
  assert.equal(cappedChats, 2);
  assert.equal(cappedQueues, 2);
  capped.close();
});

test("completion-driven state survives a fresh orchestrator and COMPLETE remains idempotent", async () => {
  const f = fixture("restart");
  const first = harness(f, ["COMPLETE"]);
  const firstResult = await first.orchestrator.run();
  assert.equal(firstResult.status, CLOSED_LOOP_PHASES.COMPLETE);
  first.orchestrator.close();
  const second = harness(f, ["CONTINUE"]);
  const secondResult = await second.orchestrator.run();
  assert.equal(secondResult.status, CLOSED_LOOP_PHASES.COMPLETE);
  assert.equal(secondResult.idempotent, true);
  assert.equal(second.chats.length, 0);
  assert.equal(second.queues.length, 0);
  second.orchestrator.close();
});

test("report hash and Supervisor response correlation remain exact", async () => {
  const f = fixture("correlation");
  const h = harness(f, ["COMPLETE"]);
  const badChat = {
    async send(input) {
      const payload = JSON.parse(input.payload);
      return createCodexPromptResponse({
        mission_id: payload.correlation.mission_id,
        task_id: payload.correlation.task_id,
        relay_request_id: payload.correlation.relay_request_id,
        report_sha256: `sha256:${"f".repeat(64)}`,
        decision: "COMPLETE",
      });
    },
  };
  // Rebuild the orchestrator with the deliberately conflicting response; the
  // parent must reject before any queue action.
  h.orchestrator.close();
  const bad = createClosedLoopOrchestrator({
    loop_id: `loop-${f.chat.task_id}-bad`,
    taskChatBinding: f.chat,
    codexContinuationBinding: f.continuation,
    codexRuntimeBinding: f.runtime,
    stateDir: path.join(f.root, "bad-state"),
    observer: h.observer,
    localRelay: { decide: async (input) => createLocalRelayDecision({ request_id: input.request_id, payload_sha256: input.payload_sha256, action: input.action_expected }) },
    chatgptTransport: badChat,
    codexSender: { send: async () => { throw new Error("must not queue"); } },
    execution_mode: CLOSED_LOOP_MODES.COMPLETION_DRIVEN,
    limits: { mode: CLOSED_LOOP_MODES.COMPLETION_DRIVEN, max_rounds: null, turn_timeout_ms: 2000, chatgpt_timeout_ms: 2000, local_relay_timeout_ms: 2000 },
    initial_turn_id: INITIAL_TURN,
    owner_id: `owner-${f.chat.task_id}-bad`,
  });
  const result = await bad.run();
  assert.equal(result.status, CLOSED_LOOP_PHASES.REJECTED);
  bad.close();
});

test("completion-driven canary evidence keeps the exact bound thread", async () => {
  const f = fixture("same-thread-evidence");
  const h = harness(f, ["CONTINUE", "COMPLETE"]);
  const result = await h.orchestrator.run();
  assert.equal(result.status, CLOSED_LOOP_PHASES.COMPLETE);
  assert.equal(result.history.length, 2);
  const continued = result.history[0];
  assert.equal(continued.decision, "CONTINUE");
  assert.equal(continued.submission_id, continued.queue_submission_id);
  assert.equal(continued.same_thread_proof, "exact_bound_thread");
  assert.equal(continued.resulting_turn_id, "turn-1");
  assert.match(continued.resulting_turn_sha256, /^sha256:[0-9a-f]{64}$/);
  h.orchestrator.close();
});
