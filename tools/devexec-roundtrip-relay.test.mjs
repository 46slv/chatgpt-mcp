import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FIXED_CHAT_URL,
  FIXED_CONVERSATION_ID,
  assertFixedTarget,
  buildCanaryChatGPTPayload,
  buildCodexReturnText,
  claimChatGPTSendSlot,
  createCanaryBindings,
  createCanaryCodexReturn,

  sha256Digest,
  validateCanaryContinue,
} from "./devexec-roundtrip-relay.mjs";
import {
  buildCodexContinuationInvocation,
  parseCodexCapabilities,
  validateCodexContinuationResult,
} from "./devexec-codex-continuation.mjs";
import {
  createCodexRuntimeBinding,
} from "./devexec-codex-runtime-binding.mjs";

const THREAD_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const THREAD_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WORK = "D:\\Documents\\Codex\\relay-task";
const BOUND_AT = "2026-09-06T00:00:00.000Z";
const MISSION = "mission-relay-1";
const TASK = "task-relay-1";
const REQUEST_ID = "relay-request-1";
const NONCE = "c41f6e09a2b5";
const REPORT = "checkpoint report body\nROUNDTRIP-CANARY-c41f6e09a2b5";
const REPORT_SHA = sha256Digest(REPORT);

function bindings() {
  return createCanaryBindings({
    mission_id: MISSION, task_id: TASK, thread_id: THREAD_A,
    working_directory: WORK, repo_root: "D:\\Documents\\Codex\\repo",
    chat_url: FIXED_CHAT_URL, bound_at: BOUND_AT,
  });
}

function continueEnvelope() {
  return {
    protocol: "devexec.codex-prompt",
    schema_version: 1,
    mission_id: MISSION,
    task_id: TASK,
    relay_request_id: REQUEST_ID,
    report_sha256: REPORT_SHA,
    decision: "CONTINUE",
    prompt: "Reply with exactly: ROUNDTRIP-RETURN-OK c41f6e09a2b5",
  };
}

test("exact fixed target bindings are accepted and pass the fixed gate", () => {
  const { taskChatBinding, continuationBinding } = bindings();
  assert.equal(taskChatBinding.conversation_id, FIXED_CONVERSATION_ID);
  assert.equal(continuationBinding.thread_id, THREAD_A);
  assert.equal(assertFixedTarget(taskChatBinding), true);
});

test("conversation_id mismatch fails closed at source-owned binding creation", () => {
  assert.throws(
    () => createCanaryBindings({
      mission_id: MISSION, task_id: TASK, thread_id: THREAD_A,
      working_directory: WORK, chat_url: "https://chatgpt.com/c/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", conversation_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }),
    (error) => error.code === "TARGET_BINDING_INVALID",
  );
});

test("a well-formed non-fixed target fails the mission fixed gate", () => {
  const other = createCanaryBindings({
    mission_id: MISSION, task_id: TASK, thread_id: THREAD_A,
    working_directory: WORK, chat_url: "https://chatgpt.com/c/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    bound_at: BOUND_AT,
  });
  assert.throws(() => assertFixedTarget(other.taskChatBinding), (error) => error.code === "ROUNDTRIP_TARGET_MISMATCH");
});

test("canary payload carries the existing CONTINUE contract and correlation ids", () => {
  const payload = buildCanaryChatGPTPayload({ report: REPORT, relay_request_id: REQUEST_ID, report_sha256: REPORT_SHA, nonce: NONCE, mission_id: MISSION, task_id: TASK });
  assert.match(payload, /devexec\.codex-prompt/);
  assert.match(payload, new RegExp(REQUEST_ID));
  assert.match(payload, new RegExp(REPORT_SHA.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")));
  assert.match(payload, new RegExp(`ROUNDTRIP-RETURN-OK ${NONCE}`));
  assert.match(payload, new RegExp(REPORT.split("\n")[1].replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")));
});

test("valid CONTINUE envelope validates against expected correlation", () => {
  const envelope = validateCanaryContinue(JSON.stringify(continueEnvelope()), {
    mission_id: MISSION, task_id: TASK, relay_request_id: REQUEST_ID, report_sha256: REPORT_SHA,
  });
  assert.equal(envelope.decision, "CONTINUE");
  assert.match(envelope.prompt, /ROUNDTRIP-RETURN-OK/);
});

test("wrong relay_request_id fails correlation closed", () => {
  assert.throws(
    () => validateCanaryContinue(JSON.stringify(continueEnvelope()), { relay_request_id: "other-request" }),
    (error) => error.code === "ROUNDTRIP_RESPONSE_INVALID",
  );
});

test("malformed and multiple envelopes are rejected", () => {
  assert.throws(() => validateCanaryContinue("not json", {}), (error) => error.code === "ROUNDTRIP_RESPONSE_INVALID");
  assert.throws(
    () => validateCanaryContinue(JSON.stringify([{ ...continueEnvelope() }, { ...continueEnvelope() }]), {}),
    (error) => error.code === "ROUNDTRIP_RESPONSE_INVALID",
  );
  const noPrompt = { ...continueEnvelope() };
  delete noPrompt.prompt;
  assert.throws(() => validateCanaryContinue(JSON.stringify(noPrompt), {}), (error) => error.code === "ROUNDTRIP_RESPONSE_INVALID");
});

test("installed CLI exposes no queue capability (documents the resume choice)", () => {
  const help = "Commands:\n  resume      Resume a session\n";
  assert.deepEqual(parseCodexCapabilities(help), { queue: false, resume: true });
});

test("resume invocation targets the exact thread with no mutable selection", () => {
  const { continuationBinding } = bindings();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-"));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const exe = path.join(dir, "codex-test.exe");
  fs.writeFileSync(exe, "fixture\n", "utf8");
  const runtime = createCodexRuntimeBinding({
    executable_path: exe, version: "codex-cli fixture 0.0.0",
    capabilities: { queue: false, resume: true }, bound_at: BOUND_AT, provenance: "test-fixture",
  });
  const request = createCanaryCodexReturn({ continuationBinding, prompt: "return prompt", response_id: REQUEST_ID });
  const invocation = buildCodexContinuationInvocation({ binding: continuationBinding, request, mode: "resume", runtime });
  assert.deepEqual(invocation.args.slice(0, 4), ["exec", "resume", "--json", THREAD_A]);
  assert.equal(invocation.args.includes("--last"), false);
});

test("resume proof for a different thread is rejected by the source-owned check", () => {
  const { continuationBinding } = bindings();
  const proof = { exitCode: 0, stdout: `${JSON.stringify({ type: "thread.started", thread_id: THREAD_B })}\n` };
  assert.throws(
    () => validateCodexContinuationResult({ binding: continuationBinding, mode: "resume", result: proof }),
    (error) => error.code === "CONTINUATION_IDENTITY_MISMATCH",
  );
});

test("ChatGPT send slot is single-flight per relay", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-slot-"));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const slot = path.join(dir, "send-slot.json");
  const first = claimChatGPTSendSlot(slot, { relay_request_id: REQUEST_ID, payload: "payload-bytes" });
  assert.equal(first.relay_request_id, REQUEST_ID);
  assert.throws(
    () => claimChatGPTSendSlot(slot, { relay_request_id: REQUEST_ID, payload: "payload-bytes" }),
    (error) => error.code === "ROUNDTRIP_DUPLICATE_SUBMIT",
  );
});

test("happy-path composition ends in a binding-validated return for the same thread", () => {
  const { continuationBinding } = bindings();
  const payload = buildCanaryChatGPTPayload({ report: REPORT, relay_request_id: REQUEST_ID, report_sha256: REPORT_SHA, nonce: NONCE, mission_id: MISSION, task_id: TASK });
  assert.match(payload, /ROUNDTRIP-CANARY-c41f6e09a2b5/);
  const envelope = validateCanaryContinue(JSON.stringify(continueEnvelope()), {
    mission_id: MISSION, task_id: TASK, relay_request_id: REQUEST_ID, report_sha256: REPORT_SHA,
  });
  const text = buildCodexReturnText({
    envelope, relay_request_id: REQUEST_ID,
    conversation_id: FIXED_CONVERSATION_ID, response_anchor: "chat-9",
  });
  assert.match(text, /DEV EXEC RELAY/);
  assert.match(text, /Reply with exactly: ROUNDTRIP-RETURN-OK c41f6e09a2b5/);
  assert.match(text, /Do not create a new task\/thread\./);
  const request = createCanaryCodexReturn({ continuationBinding, prompt: text, response_id: REQUEST_ID });
  assert.equal(request.thread_id, THREAD_A);
});
