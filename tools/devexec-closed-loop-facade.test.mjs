import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  CLOSED_LOOP_ADMISSION_PROTOCOL,
  CLOSED_LOOP_ADMISSION_SCHEMA_VERSION,
  admitExistingCodexTask,
  computeLegacyClosedLoopAdmissionId,
  createHttpLocalRelayAdapter,
  loadClosedLoopAdmission,
  runAdmittedClosedLoop,
} from "./devexec-closed-loop-facade.mjs";
import { createCodexPromptResponse, createLocalRelayDecision, hashJson } from "./devexec-full-relay.mjs";

function tempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `devexec-facade-${label}-`));
}

function uuid(seed) {
  return `00000000-0000-4000-8000-${String(seed).padStart(12, "0")}`;
}

function runtimeProbe(runtimePath) {
  const bytes = fs.readFileSync(runtimePath);
  const sha = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
  return {
    executable_path: runtimePath,
    launch_args: [],
    version: "codex-test-runtime",
    capabilities: { queue: true, resume: true },
    fingerprint_files: [{ path: runtimePath, realpath: fs.realpathSync(runtimePath), size: bytes.length, sha256: sha }],
  };
}

function baseInput(root) {
  const runtimePath = path.join(root, "codex.exe");
  fs.writeFileSync(runtimePath, "codex-test-runtime", "utf8");
  const threadId = uuid(1);
  const initialTurnId = uuid(2);
  return {
    mission_id: "mission-facade-test",
    task_id: "task-facade-test",
    thread_id: threadId,
    initial_turn_id: initialTurnId,
    chat_url: "https://chatgpt.com/g/g-p-facade/c/facade-conversation",
    runtime_path: runtimePath,
    working_directory: root,
    repo_root: root,
    admission_root: path.join(root, "admissions"),
    runtime_probe: async () => runtimeProbe(runtimePath),
    thread_probe: async () => ({ thread_id: threadId, turn_id: initialTurnId, turn_status: "completed", message: "Initial persisted task completion." }),
    now: () => "2026-09-02T12:00:00.000Z",
    max_rounds: 2,
  };
}

test("admitExistingCodexTask persists exact identities and is idempotent", async () => {
  const root = tempRoot("admit");
  const input = baseInput(root);
  const first = await admitExistingCodexTask(input);
  assert.equal(first.created, true);
  assert.equal(first.admission.protocol, CLOSED_LOOP_ADMISSION_PROTOCOL);
  assert.equal(first.admission.schema_version, CLOSED_LOOP_ADMISSION_SCHEMA_VERSION);
  assert.equal(first.admission.codex_continuation_binding.thread_id, input.thread_id);
  assert.equal(first.admission.initial_turn_id, input.initial_turn_id);
  assert.equal(first.admission.thread_probe.turn_id, input.initial_turn_id);
  assert.equal(first.admission.task_chat_binding.chat_url, input.chat_url);
  assert.equal(first.admission.codex_runtime_binding.capabilities.queue, true);
  assert.equal(loadClosedLoopAdmission(first.file).admission_id, first.admission.admission_id);

  const second = await admitExistingCodexTask({
    ...input,
    runtime_probe: async () => { throw new Error("existing admission must not re-probe runtime"); },
    thread_probe: async () => { throw new Error("existing admission must not re-probe thread"); },
  });
  assert.equal(second.created, false);
  assert.equal(second.admission.admission_id, first.admission.admission_id);
  assert.deepEqual(second.thread_identity, first.thread_identity);
});

test("legacy bounded admission id remains loadable after the completion-driven extension", async () => {
  const root = tempRoot("legacy-id");
  const input = baseInput(root);
  const legacyId = computeLegacyClosedLoopAdmissionId({
    mission_id: input.mission_id,
    task_id: input.task_id,
    initial_turn_id: input.initial_turn_id,
    task_chat_binding: { chat_url: input.chat_url, conversation_id: "facade-conversation" },
    codex_continuation_binding: { thread_id: input.thread_id, working_directory: input.working_directory, repo_root: input.repo_root },
    codex_runtime_binding: { executable_path: input.runtime_path },
  });
  const first = await admitExistingCodexTask({ ...input, admission_id: legacyId });
  const second = await admitExistingCodexTask({
    ...input,
    runtime_probe: async () => { throw new Error("legacy admission must not re-probe runtime"); },
    thread_probe: async () => { throw new Error("legacy admission must not re-probe thread"); },
  });
  assert.equal(first.admission.admission_id, legacyId);
  assert.equal(second.created, false);
  assert.equal(second.admission.admission_id, legacyId);
});
test("admission requires explicit URL, absolute runtime, absolute worktree, and exact initial turn", async () => {
  const root = tempRoot("strict");
  const input = baseInput(root);
  const oldTarget = process.env.CHATGPT_MCP_CHAT_URL;
  process.env.CHATGPT_MCP_CHAT_URL = "https://chatgpt.com/c/wrong-default";
  try {
    await assert.rejects(() => admitExistingCodexTask({ ...input, chat_url: undefined }), /chat_url/);
    await assert.rejects(() => admitExistingCodexTask({ ...input, runtime_path: "codex.exe" }), /absolute path/);
    await assert.rejects(() => admitExistingCodexTask({ ...input, working_directory: "relative" }), /absolute path/);
    await assert.rejects(() => admitExistingCodexTask({ ...input, initial_turn_id: "not-a-uuid" }), /UUID/);
  } finally {
    if (oldTarget === undefined) delete process.env.CHATGPT_MCP_CHAT_URL;
    else process.env.CHATGPT_MCP_CHAT_URL = oldTarget;
  }
});

test("Local Model RELAY adapter sends only the hash/action envelope", async () => {
  let requestUrl = null;
  let requestBody = null;
  const response = {
    choices: [{ message: { content: JSON.stringify({ protocol: "devexec.local-relay-decision", schema_version: 1, request_id: "relay-1", payload_sha256: `sha256:${"a".repeat(64)}`, action: "FORWARD_REPORT" }) } }],
  };
  const adapter = createHttpLocalRelayAdapter({
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "qwen/test",
    fetchImpl: async (url, options) => {
      requestUrl = url;
      requestBody = JSON.parse(options.body);
      return { ok: true, status: 200, text: async () => JSON.stringify(response) };
    },
  });
  const result = await adapter.decide({ protocol: "devexec.local-relay-decision", schema_version: 1, mode: "RELAY", request_id: "relay-1", payload_sha256: `sha256:${"a".repeat(64)}`, action_expected: "FORWARD_REPORT" });
  assert.equal(result.action, "FORWARD_REPORT");
  assert.equal(requestUrl, "http://127.0.0.1:1234/v1/chat/completions");
  const serialized = JSON.stringify(requestBody);
  assert.equal(serialized.includes("thread_id"), false);
  assert.equal(serialized.includes("chat_url"), false);
  assert.equal(serialized.includes("prompt_bytes"), false);
  assert.equal(requestBody.model, "qwen/test");
});

test("runAdmittedClosedLoop wires two real relay rounds to the admitted thread", async () => {
  const root = tempRoot("run");
  const input = baseInput(root);
  const admitted = await admitExistingCodexTask(input);
  const threadId = input.thread_id;
  const resultingTurnId = uuid(3);
  let waitCount = 0;
  let sendCount = 0;
  const decisions = ["CONTINUE", "STOP"];
  const observer = {
    wait: async (expected) => {
      waitCount += 1;
      const turnId = waitCount === 1 ? input.initial_turn_id : resultingTurnId;
      const message = waitCount === 1 ? "Initial persisted task completion." : "Implemented the small real task and verified its focused test.";
      const output = { kind: "TURN_COMPLETED", thread_id: threadId, turn_id: turnId, turn_status: "completed", message };
      if (waitCount > 1) output.user_prompt = expected.prompt;
      return output;
    },
    checkpoint: () => ({ sequence: waitCount }),
    close: () => {},
  };
  const localRelay = { decide: async (request) => createLocalRelayDecision({ request_id: request.request_id, payload_sha256: request.payload_sha256, action: request.action_expected }) };
  const chatgptTransport = { send: async (request) => {
    const correlation = JSON.parse(request.payload).correlation;
    const decision = decisions[sendCount++];
    return createCodexPromptResponse({
      mission_id: correlation.mission_id,
      task_id: correlation.task_id,
      relay_request_id: correlation.relay_request_id,
      report_sha256: correlation.report_sha256,
      decision,
      prompt: decision === "CONTINUE" ? "Add the focused facade assertion and run its test." : undefined,
      prompt_id: decision === "CONTINUE" ? "prompt-facade-1" : undefined,
    });
  } };
  const codexSender = { send: async (request) => ({ status: "DISPATCHED", dispatched: true, mode: "queue", return_id: request.return_id, thread_id: threadId, submission_id: "submission-facade-1" }), inspect: () => null };
  const result = await runAdmittedClosedLoop({ admission: admitted.admission, observer, localRelay, chatgptTransport, codexSender, ownerId: "facade-test-owner", now: () => "2026-09-02T12:00:00.000Z" });
  assert.equal(result.result.status, "STOPPED");
  assert.equal(result.result.thread_id, threadId);
  assert.deepEqual(result.result.history.map((entry) => entry.decision), ["CONTINUE", "STOP"]);
  assert.equal(result.result.history[0].submission_id, "submission-facade-1");
  assert.equal(result.result.history[0].resulting_turn_id, resultingTurnId);
  assert.equal(result.evidence.same_thread_identity, true);
  assert.equal(result.evidence.queue_submissions[0].thread_id, threadId);
  assert.equal(sendCount, 2);
  assert.equal(waitCount, 2);
  assert.equal(result.state.thread_id, threadId);
  assert.equal(hashJson(result.state.history) !== null, true);
});

test("runAdmittedClosedLoop exposes Supervisor COMPLETE as a semantic terminal", async () => {
  const root = tempRoot("completion");
  const input = { ...baseInput(root), execution_mode: "completion-driven", max_rounds: null, goal: "Finish the facade canary", current_task: "Run the exact initial task" };
  const admitted = await admitExistingCodexTask(input);
  let waitCount = 0;
  let sendCount = 0;
  const observer = {
    wait: async (expected) => {
      waitCount += 1;
      const turnId = waitCount === 1 ? input.initial_turn_id : uuid(4);
      const value = { kind: "TURN_COMPLETED", thread_id: input.thread_id, turn_id: turnId, turn_status: "completed", message: "Codex says done (evidence only)." };
      if (waitCount > 1) value.user_prompt = expected.prompt;
      return value;
    },
    checkpoint: () => ({ sequence: waitCount }),
    close: () => {},
  };
  const localRelay = { decide: async (request) => createLocalRelayDecision({ request_id: request.request_id, payload_sha256: request.payload_sha256, action: request.action_expected }) };
  const chatgptTransport = { send: async (request) => {
    const correlation = JSON.parse(request.payload).correlation;
    const decision = sendCount++ === 0 ? "CONTINUE" : "COMPLETE";
    return createCodexPromptResponse({
      mission_id: correlation.mission_id,
      task_id: correlation.task_id,
      relay_request_id: correlation.relay_request_id,
      report_sha256: correlation.report_sha256,
      decision,
      prompt: decision === "CONTINUE" ? "Run the exact follow-up facade check." : undefined,
      prompt_id: decision === "CONTINUE" ? "facade-completion-prompt" : undefined,
    });
  } };
  const codexSender = { send: async (request) => ({ status: "DISPATCHED", dispatched: true, mode: "queue", return_id: request.return_id, thread_id: input.thread_id, submission_id: "submission-completion-1" }), inspect: () => null };
  const result = await runAdmittedClosedLoop({ admission: admitted.admission, observer, localRelay, chatgptTransport, codexSender, ownerId: "facade-completion-owner", now: () => "2026-09-02T12:00:00.000Z" });
  assert.equal(result.result.status, "COMPLETE");
  assert.equal(result.result.semantic_terminal, true);
  assert.equal(result.result.supervisor_decision, "COMPLETE");
  assert.deepEqual(result.result.history.map((entry) => entry.decision), ["CONTINUE", "COMPLETE"]);
  assert.equal(result.result.history[0].same_thread_proof, "exact_bound_thread");
  assert.equal(result.evidence.execution_mode, "completion-driven");
  assert.equal(result.evidence.semantic_terminal, true);
  assert.equal(waitCount, 2);
  assert.equal(sendCount, 2);
});
