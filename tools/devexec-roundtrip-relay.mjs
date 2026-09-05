// devexec-roundtrip-relay.mjs — THIN manual-copy/paste-replacement launcher.
//
// One bounded round trip: Codex report -> exact fixed ChatGPT conversation
// -> ChatGPT CONTINUE envelope -> SAME Codex thread. No autonomous loop.
//
// This file is intentionally thin. All protocol work is source-owned:
//   target parse/validate .... tools/devexec-task-chat-binding.mjs
//   CONTINUE envelope ........ tools/devexec-full-relay.mjs (validateCodexPromptResponse)
//   thread binding/return .... tools/devexec-codex-continuation.mjs
//   runtime binding .......... tools/devexec-codex-runtime-binding.mjs
//   ChatGPT submit/poll ..... src/chatgpt.ts blockingReply (dist/chatgpt.js)
// This layer only composes those pieces, builds the canary payload text,
// keeps a minimal evidence receipt, and guards the single ChatGPT send with
// an exclusive claim file. It implements no parser, validator, invocation
// builder, dedupe algorithm, state machine, or response poller of its own.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  createTaskChatBinding,
} from "./devexec-task-chat-binding.mjs";
import {
  validateCodexPromptResponse,
} from "./devexec-full-relay.mjs";
import {
  CODEX_CONTINUATION_MODE,
  createCodexContinuationBinding,
  createCodexContinuationReturn,
  createCodexContinuationSender,
} from "./devexec-codex-continuation.mjs";
import {
  createCodexRuntimeBinding,
} from "./devexec-codex-runtime-binding.mjs";

export const FIXED_CHAT_URL =
  "https://chatgpt.com/g/g-p-6a89cb9b964c8191856c19fe81fab4a3-dev-exec/c/6a9c569d-4134-83ee-8f19-0f2c50091f2e";
export const FIXED_CONVERSATION_ID = "6a9c569d-4134-83ee-8f19-0f2c50091f2e";

export const CANARY_CONTINUE_DECISION = "CONTINUE";

export class RoundtripRelayError extends Error {
  constructor(message, code = "ROUNDTRIP_INVALID") {
    super(message);
    this.name = "RoundtripRelayError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new RoundtripRelayError(message, code);
}

function requiredText(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    fail("ROUNDTRIP_REQUIRED", `${label} must be an exact non-empty string.`);
  }
  return value;
}

export function sha256Digest(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value), "utf8").digest("hex")}`;
}

// ---- source-owned bindings (exact, no alias/default resolution) ----
export function createCanaryBindings({ mission_id, task_id, thread_id, working_directory, repo_root, chat_url, conversation_id, bound_at } = {}) {
  const chatInput = { mission_id: requiredText(mission_id, "mission_id"), task_id: requiredText(task_id, "task_id"), chat_url: requiredText(chat_url, "chat_url") };
  if (conversation_id !== undefined) chatInput.conversation_id = requiredText(conversation_id, "conversation_id");
  const codexInput = { mission_id: chatInput.mission_id, task_id: chatInput.task_id, thread_id: requiredText(thread_id, "thread_id"), working_directory: requiredText(working_directory, "working_directory") };
  if (bound_at !== undefined) {
    chatInput.bound_at = requiredText(bound_at, "bound_at");
    codexInput.bound_at = chatInput.bound_at;
  }
  if (repo_root !== undefined) codexInput.repo_root = repo_root;
  // Throws (source-owned codes) on any mismatch: nothing here re-validates.
  const taskChatBinding = createTaskChatBinding(chatInput);
  const continuationBinding = createCodexContinuationBinding(codexInput);
  return Object.freeze({ taskChatBinding, continuationBinding });
}

export function createCanaryRuntimeBinding({ executable_path, version, capabilities, bound_at, provenance = "explicit-canary-runtime" } = {}) {
  return createCodexRuntimeBinding({ executable_path, version, capabilities, bound_at, provenance });
}

// Mission fixed-target gate: drift fails closed.
export function assertFixedTarget(taskChatBinding) {
  if (taskChatBinding?.chat_url !== FIXED_CHAT_URL || taskChatBinding?.conversation_id !== FIXED_CONVERSATION_ID) {
    fail("ROUNDTRIP_TARGET_MISMATCH", "Chat target is not the mission fixed ChatGPT conversation.");
  }
  return true;
}

// ---- canary payload: asks ChatGPT for the EXISTING devexec.codex-prompt CONTINUE envelope ----
export function buildCanaryChatGPTPayload({ report, relay_request_id, report_sha256, nonce, mission_id, task_id } = {}) {
  const body = requiredText(report, "report");
  const requestId = requiredText(relay_request_id, "relay_request_id");
  const hash = requiredText(report_sha256, "report_sha256");
  const tag = requiredText(nonce, "nonce");
  return [
    "This is a Dev Exec supervisor relay canary.",
    "",
    "Below is the report from the currently bound Codex task.",
    "",
    body,
    "",
    "Reply with exactly one JSON object and nothing else, using this shape:",
    "{",
    '  "protocol": "devexec.codex-prompt",',
    '  "schema_version": 1,',
    `  "mission_id": "${requiredText(mission_id, "mission_id")}",`,
    `  "task_id": "${requiredText(task_id, "task_id")}",`,
    `  "relay_request_id": "${requestId}",`,
    `  "report_sha256": "${hash}",`,
    '  "decision": "CONTINUE",',
    `  "prompt": "Reply with exactly: ROUNDTRIP-RETURN-OK ${tag}"`,
    "}",
    "No extra text, no second object, no code fence.",
  ].join("\n");
}

// ---- existing-contract CONTINUE validation (thin wrapper, source-owned check) ----
export function validateCanaryContinue(envelope, expected = {}) {
  try {
    return validateCodexPromptResponse(envelope, expected);
  } catch (error) {
    fail("ROUNDTRIP_RESPONSE_INVALID", `ChatGPT CONTINUE envelope rejected: ${error.message}`);
  }
}

// ---- Codex return text: provenance envelope + verbatim prompt bytes ----
export function buildCodexReturnText({ envelope, relay_request_id, conversation_id, response_anchor } = {}) {
  const prompt = envelope?.prompt;
  if (typeof prompt !== "string" || prompt.length === 0) fail("ROUNDTRIP_REQUIRED", "CONTINUE envelope carries no prompt.");
  const anchor = response_anchor === undefined || response_anchor === null ? "unknown" : String(response_anchor);
  return [
    "[DEV EXEC RELAY — CHATGPT RESPONSE]",
    "",
    `relay_request_id: ${requiredText(relay_request_id, "relay_request_id")}`,
    "source: ChatGPT",
    `conversation_id: ${requiredText(conversation_id, "conversation_id")}`,
    `response_anchor: ${anchor}`,
    "",
    "The following is the supervisor reply from ChatGPT:",
    "",
    prompt,
    "",
    "Continue the existing task using this reply as supervisor feedback.",
    "Do not create a new task/thread.",
  ].join("\n");
}

// ---- source-owned Codex sender (resume required: installed CLI 0.147.0 has no queue) ----
export function createCanaryCodexSender({ continuationBinding, runtimeBinding, invoke } = {}) {
  return createCodexContinuationSender({
    binding: continuationBinding,
    runtime: runtimeBinding,
    required_mode: CODEX_CONTINUATION_MODE.RESUME,
    invoke,
  });
}

export function createCanaryCodexReturn({ continuationBinding, prompt, response_id } = {}) {
  return createCodexContinuationReturn({ binding: continuationBinding, prompt: requiredText(prompt, "prompt"), response_id: requiredText(response_id, "response_id") });
}

// ---- minimal evidence receipt + exclusive single-send claim (guard only, no state machine) ----
export function writeEvidenceReceipt(filePath, record) {
  if (typeof filePath !== "string" || filePath.length === 0) fail("ROUNDTRIP_REQUIRED", "Receipt path is required.");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
  return filePath;
}

// Exactly one ChatGPT send per relay_request_id: exclusive create fails closed on replay.
export function claimChatGPTSendSlot(slotPath, payload) {
  if (typeof slotPath !== "string" || slotPath.length === 0) fail("ROUNDTRIP_REQUIRED", "Send slot path is required.");
  fs.mkdirSync(path.dirname(slotPath), { recursive: true });
  const record = { relay_request_id: payload?.relay_request_id || null, payload_sha256: sha256Digest(payload?.payload || ""), claimed_at: new Date().toISOString() };
  let fd;
  try {
    fd = fs.openSync(slotPath, "wx");
  } catch (error) {
    if (error?.code === "EEXIST") fail("ROUNDTRIP_DUPLICATE_SUBMIT", "ChatGPT send slot already claimed; resend is forbidden.");
    throw error;
  }
  try {
    fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
  return Object.freeze(record);
}
