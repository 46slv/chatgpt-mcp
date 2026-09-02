import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  CODEX_PROMPT_DECISIONS,
  FULL_RELAY_ERRORS,
  FULL_RELAY_STATES,
  canonicalJson,
  createFullRelayOrchestrator,
  hashJson,
  sha256,
} from "./devexec-full-relay.mjs";
import { createTaskChatRelayReport, validateTaskChatBinding } from "./devexec-task-chat-binding.mjs";
import { validateCodexContinuationBinding } from "./devexec-codex-continuation.mjs";
import {
  CODEX_RUNTIME_ERRORS,
  validateCodexRuntimeBinding,
  verifyCodexRuntimeBinding,
} from "./devexec-codex-runtime-binding.mjs";

export const CLOSED_LOOP_PROTOCOL = "devexec.closed-loop-run";
export const CLOSED_LOOP_SCHEMA_VERSION = 1;

export const CLOSED_LOOP_PHASES = Object.freeze({
  READY: "READY",
  WAITING_FOR_CODEX_TURN: "WAITING_FOR_CODEX_TURN",
  ROUND_PREPARED: "ROUND_PREPARED",
  RELAY_IN_PROGRESS: "RELAY_IN_PROGRESS",
  WAITING_FOR_CODEX_AFTER_CONTINUE: "WAITING_FOR_CODEX_AFTER_CONTINUE",
  STOPPED: "STOPPED",
  NEEDS_HUMAN: "NEEDS_HUMAN",
  MAX_ROUNDS_REACHED: "MAX_ROUNDS_REACHED",
  DELIVERY_UNKNOWN: "DELIVERY_UNKNOWN",
  REJECTED: "REJECTED",
  CANCELLED: "CANCELLED",
});

export const CLOSED_LOOP_STATES = CLOSED_LOOP_PHASES;
export const CLOSED_LOOP_STATE = CLOSED_LOOP_PHASES;

export const CLOSED_LOOP_ERRORS = Object.freeze({
  REQUIRED: "CLOSED_LOOP_REQUIRED",
  INVALID: "CLOSED_LOOP_INVALID",
  STATE_INVALID: "CLOSED_LOOP_STATE_INVALID",
  STATE_BUSY: "CLOSED_LOOP_STATE_BUSY",
  IDENTITY_MISMATCH: "CLOSED_LOOP_IDENTITY_MISMATCH",
  REPORT_CONFLICT: "CLOSED_LOOP_REPORT_CONFLICT",
  OWNER_HELD: "CLOSED_LOOP_OWNER_HELD",
  OWNER_INVALID: "CLOSED_LOOP_OWNER_INVALID",
  OWNER_REQUIRED: "CLOSED_LOOP_OWNER_REQUIRED",
  OBSERVER_REQUIRED: "CLOSED_LOOP_OBSERVER_REQUIRED",
  OBSERVER_INVALID: "CLOSED_LOOP_OBSERVER_INVALID",
  OBSERVER_AMBIGUOUS: "CLOSED_LOOP_OBSERVER_AMBIGUOUS",
  OBSERVER_TIMEOUT: "CLOSED_LOOP_OBSERVER_TIMEOUT",
  OBSERVER_DISCONNECTED: "CLOSED_LOOP_OBSERVER_DISCONNECTED",
  WRONG_THREAD: "CLOSED_LOOP_WRONG_THREAD",
  WRONG_TURN: "CLOSED_LOOP_WRONG_TURN",
  CAUSALITY_MISMATCH: "CLOSED_LOOP_CAUSALITY_MISMATCH",
  TURN_INVALID: "CLOSED_LOOP_TURN_INVALID",
  TURN_CONFLICT: "CLOSED_LOOP_TURN_CONFLICT",
  TURN_NOT_COMPLETED: "CLOSED_LOOP_TURN_NOT_COMPLETED",
  CONTEXT_ROTATION_REQUIRED: "CLOSED_LOOP_CONTEXT_ROTATION_REQUIRED",
  LIMIT_INVALID: "CLOSED_LOOP_LIMIT_INVALID",
  RUNTIME_DRIFT: CODEX_RUNTIME_ERRORS.DRIFT,
  RUNTIME_INVALID: CODEX_RUNTIME_ERRORS.INVALID,
  RUNTIME_UNAVAILABLE: CODEX_RUNTIME_ERRORS.UNAVAILABLE,
});

export const CLOSED_LOOP_TERMINAL_PHASES = Object.freeze([
  CLOSED_LOOP_PHASES.STOPPED,
  CLOSED_LOOP_PHASES.NEEDS_HUMAN,
  CLOSED_LOOP_PHASES.MAX_ROUNDS_REACHED,
  CLOSED_LOOP_PHASES.DELIVERY_UNKNOWN,
  CLOSED_LOOP_PHASES.REJECTED,
  CLOSED_LOOP_PHASES.CANCELLED,
]);

export const CODEX_APP_SERVER_METHODS = Object.freeze({
  INITIALIZE: "initialize",
  INITIALIZED: "initialized",
  THREAD_RESUME: "thread/resume",
  THREAD_READ: "thread/read",
  THREAD_TURNS_LIST: "thread/turns/list",
  THREAD_ITEMS_LIST: "thread/items/list",
  THREAD_UNSUBSCRIBE: "thread/unsubscribe",
});

export const CODEX_APP_SERVER_EVENTS = Object.freeze({
  THREAD_STARTED: "thread/started",
  THREAD_STATUS_CHANGED: "thread/status/changed",
  TURN_STARTED: "turn/started",
  TURN_COMPLETED: "turn/completed",
  ITEM_STARTED: "item/started",
  ITEM_COMPLETED: "item/completed",
});

const MAX_STATE_BYTES = 1024 * 1024;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_APP_SERVER_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_HISTORY = 21;
const MAX_OBSERVER_TURNS = 256;
const MAX_OBSERVER_ITEMS_PER_TURN = 512;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/i;
const OWNER_FIELDS = Object.freeze([
  "protocol",
  "schema_version",
  "lineage_sha256",
  "loop_id",
  "thread_id",
  "owner_id",
  "nonce",
  "acquired_at",
]);
const LOOP_STATE_FIELDS = new Set([
  "protocol",
  "schema_version",
  "loop_id",
  "mission_id",
  "task_id",
  "task_chat_binding_id",
  "conversation_id",
  "codex_continuation_binding_id",
  "codex_runtime_binding_id",
  "codex_runtime_fingerprint",
  "thread_id",
  "limits",
  "round_index",
  "last_observed_turn_id",
  "last_observed_turn_sha256",
  "last_observed_turn_status",
  "last_observed_message",
  "last_observed_causal_proof",
  "current_relay_request_id",
  "current_report",
  "current_report_sha256",
  "expected_after_turn_id",
  "expected_prompt",
  "expected_prompt_sha256",
  "expected_submission_id",
  "expected_observer_sequence",
  "observer_checkpoint",
  "pending_history",
  "history",
  "phase",
  "terminal_reason",
  "error_code",
  "error_message",
  "created_at",
  "updated_at",
]);

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredText(value, label, code = CLOSED_LOOP_ERRORS.REQUIRED) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new ClosedLoopError(`${label} must be an exact non-empty string.`, code);
  }
  return value;
}

function optionalText(value, label, code = CLOSED_LOOP_ERRORS.INVALID) {
  if (value === null || value === undefined) return null;
  return requiredText(value, label, code);
}

function boundedText(value, label, maxBytes = MAX_MESSAGE_BYTES, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new ClosedLoopError(`${label} is required.`, CLOSED_LOOP_ERRORS.REQUIRED);
    return null;
  }
  if (typeof value !== "string" || (required && value.length === 0)) throw new ClosedLoopError(`${label} must be a non-empty text value.`, CLOSED_LOOP_ERRORS.INVALID);
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new ClosedLoopError(`${label} exceeds the bounded size.`, CLOSED_LOOP_ERRORS.INVALID);
  }
  return value;
}

function nullableBoundedText(value, label, maxBytes = MAX_MESSAGE_BYTES) {
  if (value === null || value === undefined) return null;
  return boundedText(value, label, maxBytes, { required: true });
}

function cloneFrozen(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneFrozen));
  if (isObject(value)) {
    const clone = {};
    for (const [key, child] of Object.entries(value)) clone[key] = cloneFrozen(child);
    return Object.freeze(clone);
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJsonValue(value, label = "value") {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new ClosedLoopError(`${label} is not valid JSON.`, CLOSED_LOOP_ERRORS.OBSERVER_INVALID, error);
  }
}

function digestValue(value) {
  return sha256(typeof value === "string" || Buffer.isBuffer(value) ? value : canonicalJson(value));
}

function isDigest(value) {
  return typeof value === "string" && DIGEST_RE.test(value);
}

function normalizeEventMethod(value) {
  if (typeof value !== "string") return null;
  if (value === "turn.completed") return CODEX_APP_SERVER_EVENTS.TURN_COMPLETED;
  if (value === "turn.started") return CODEX_APP_SERVER_EVENTS.TURN_STARTED;
  if (value === "thread.status.changed") return CODEX_APP_SERVER_EVENTS.THREAD_STATUS_CHANGED;
  if (value === "item.started") return CODEX_APP_SERVER_EVENTS.ITEM_STARTED;
  if (value === "item.completed") return CODEX_APP_SERVER_EVENTS.ITEM_COMPLETED;
  return value;
}

function eventParams(event) {
  if (!isObject(event)) return null;
  return isObject(event.params) ? event.params : event;
}

function eventMethod(event) {
  if (!isObject(event)) return null;
  return normalizeEventMethod(event.method || event.event || (typeof event.type === "string" ? event.type : null));
}

function threadIdFrom(value) {
  if (!isObject(value)) return null;
  return value.threadId || value.thread_id || value.thread?.id || value.thread?.threadId || null;
}

function turnFrom(value) {
  if (!isObject(value)) return null;
  return isObject(value.turn) ? value.turn : null;
}

function turnIdFrom(value) {
  if (!isObject(value)) return null;
  return value.turnId || value.turn_id || value.turn?.id || null;
}

function itemFrom(value) {
  if (!isObject(value)) return null;
  return isObject(value.item) ? value.item : null;
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((entry) => {
    if (typeof entry === "string") return entry;
    if (!isObject(entry)) return "";
    return typeof entry.text === "string" ? entry.text : "";
  }).join("");
}

function agentMessageText(item) {
  if (!isObject(item)) return null;
  const type = item.type;
  if (type !== "agentMessage" && type !== "agent_message" && !(type === "message" && item.role === "assistant")) return null;
  if (typeof item.text === "string" && item.text.length > 0) return item.text;
  const text = textFromContent(item.content);
  return text.length > 0 ? text : null;
}

function userMessageText(item) {
  if (!isObject(item)) return null;
  const type = item.type;
  if (type !== "userMessage" && type !== "user_message" && !(type === "message" && item.role === "user")) return null;
  if (typeof item.text === "string" && item.text.length > 0) return item.text;
  const text = textFromContent(item.content);
  return text.length > 0 ? text : null;
}

function completedTurnMessage(turn, extraItems = []) {
  const items = [];
  if (Array.isArray(turn?.items)) items.push(...turn.items);
  items.push(...extraItems);
  const candidates = items.map((item) => ({ item, text: agentMessageText(item) })).filter((entry) => entry.text !== null);
  if (candidates.length === 0) return null;
  const final = candidates.find((entry) => entry.item.phase === "final_answer") || candidates[candidates.length - 1];
  return final.text;
}

function turnUserPrompt(turn, extraItems = []) {
  const items = [];
  if (Array.isArray(turn?.items)) items.push(...turn.items);
  items.push(...extraItems);
  const prompts = items.map(userMessageText).filter((value) => value !== null);
  if (prompts.length === 0) return null;
  return prompts[prompts.length - 1];
}

function turnCausalIds(value, fallbackTurn = null) {
  const p = eventParams(value) || {};
  const turn = turnFrom(p) || fallbackTurn || {};
  return {
    submission_id: p.submissionId || p.submission_id || p.queuedSubmissionId || p.queued_submission_id || turn.submissionId || turn.submission_id || null,
    codex_return_id: p.codexReturnId || p.codex_return_id || turn.codexReturnId || turn.codex_return_id || null,
  };
}

function normalizeCompletedTurn({ thread_id, turn, event = null, extraItems = [], source = "notification", sequence = null } = {}) {
  if (!isObject(turn)) throw new ClosedLoopError("turn/completed must include a turn object.", CLOSED_LOOP_ERRORS.TURN_INVALID);
  const turnId = requiredText(turn.id || turn.turnId || turn.turn_id, "turn.id", CLOSED_LOOP_ERRORS.TURN_INVALID);
  const status = requiredText(turn.status, "turn.status", CLOSED_LOOP_ERRORS.TURN_INVALID);
  if (status !== "completed") throw new ClosedLoopError("Only completed Codex turns may be admitted.", CLOSED_LOOP_ERRORS.TURN_NOT_COMPLETED);
  const message = boundedText(completedTurnMessage(turn, extraItems), "turn final agent message", MAX_MESSAGE_BYTES, { required: true });
  const prompt = boundedText(turnUserPrompt(turn, extraItems), "turn user prompt", MAX_PROMPT_BYTES);
  const causalIds = turnCausalIds(event || {}, turn);
  const sourceTurn = {
    thread_id: requiredText(thread_id, "thread_id", CLOSED_LOOP_ERRORS.TURN_INVALID),
    turn_id: turnId,
    turn_status: status,
    message,
  };
  return Object.freeze({
    kind: "TURN_COMPLETED",
    source,
    sequence,
    thread_id: sourceTurn.thread_id,
    turn_id: sourceTurn.turn_id,
    turn_status: sourceTurn.turn_status,
    message,
    user_prompt: prompt,
    submission_id: optionalText(causalIds.submission_id, "submission_id"),
    codex_return_id: optionalText(causalIds.codex_return_id, "codex_return_id"),
    source_turn_sha256: digestValue(sourceTurn),
    raw_event_sha256: event ? digestValue(event) : null,
    causal_proof: prompt !== null ? "turn_prompt_exact" : "turn_identity_only",
  });
}

/**
 * Parse one native app-server JSON-RPC notification. Wrong-thread events are
 * deliberately returned as ignored observations so an observer can continue
 * waiting without consuming another task's event.
 */
export function parseCodexAppServerNotification(value, { thread_id, threadId, sequence = null, extraItems = [] } = {}) {
  const parsed = parseJsonValue(value, "app-server notification");
  if (!isObject(parsed)) throw new ClosedLoopError("app-server notification must be an object.", CLOSED_LOOP_ERRORS.OBSERVER_INVALID);
  const method = eventMethod(parsed);
  const params = eventParams(parsed);
  const expectedThread = thread_id || threadId;
  const observedThread = threadIdFrom(params);
  if (observedThread !== null && expectedThread !== undefined && observedThread !== expectedThread) {
    return Object.freeze({ kind: "IGNORED", reason: "WRONG_THREAD", method, thread_id: observedThread, sequence });
  }
  if (method !== CODEX_APP_SERVER_EVENTS.TURN_COMPLETED) {
    if (method === CODEX_APP_SERVER_EVENTS.TURN_STARTED) {
      const turn = turnFrom(params);
      return Object.freeze({ kind: "TURN_STARTED", method, thread_id: observedThread || expectedThread || null, turn_id: turnIdFrom(params), turn, sequence });
    }
    if (method === CODEX_APP_SERVER_EVENTS.ITEM_STARTED || method === CODEX_APP_SERVER_EVENTS.ITEM_COMPLETED) {
      return Object.freeze({ kind: method === CODEX_APP_SERVER_EVENTS.ITEM_STARTED ? "ITEM_STARTED" : "ITEM_COMPLETED", method, thread_id: observedThread || expectedThread || null, turn_id: turnIdFrom(params), item: itemFrom(params), sequence });
    }
    return Object.freeze({ kind: "IGNORED", reason: "UNRELATED_EVENT", method, thread_id: observedThread || expectedThread || null, sequence });
  }
  const turn = turnFrom(params);
  if (expectedThread !== undefined && observedThread === null) {
    throw new ClosedLoopError("turn/completed did not carry an exact threadId.", CLOSED_LOOP_ERRORS.TURN_INVALID);
  }
  const result = normalizeCompletedTurn({
    thread_id: observedThread,
    turn,
    event: parsed,
    extraItems,
    source: "notification",
    sequence,
  });
  return result;
}

export const parseCodexAppServerEvent = parseCodexAppServerNotification;
export const parseCodexTurnNotification = parseCodexAppServerNotification;

/** Parse JSONL notification output without associating by line/arrival order. */
export function parseCodexAppServerNotifications(value, options = {}) {
  const events = [];
  const errors = [];
  const values = Array.isArray(value) ? value : isObject(value) ? [value] : String(value || "").split(/\r?\n/).filter((line) => line.trim()).map((line) => line);
  let sequence = 0;
  for (const entry of values) {
    try {
      events.push(parseCodexAppServerNotification(entry, { ...options, sequence }));
    } catch (error) {
      errors.push({ sequence, code: error?.code || CLOSED_LOOP_ERRORS.OBSERVER_INVALID, message: String(error?.message || error) });
    }
    sequence += 1;
  }
  return Object.freeze({ events: Object.freeze(events), parse_errors: Object.freeze(errors) });
}

export const parseCodexAppServerEventStream = parseCodexAppServerNotifications;

function normalizeExpected(input = {}, expectedThread) {
  if (!isObject(input)) throw new ClosedLoopError("Observer expectation must be an object.", CLOSED_LOOP_ERRORS.OBSERVER_INVALID);
  const thread = input.thread_id || input.threadId || expectedThread;
  requiredText(thread, "expected.thread_id", CLOSED_LOOP_ERRORS.OBSERVER_INVALID);
  const afterTurn = input.after_turn_id || input.afterTurnId || null;
  const turnId = input.turn_id || input.turnId || null;
  const prompt = input.prompt === undefined || input.prompt === null ? null : boundedText(input.prompt, "expected.prompt", MAX_PROMPT_BYTES);
  const submissionId = input.submission_id || input.submissionId || null;
  const afterSequence = input.after_sequence ?? input.afterSequence ?? null;
  if (afterSequence !== null && (!Number.isInteger(afterSequence) || afterSequence < 0)) {
    throw new ClosedLoopError("expected.after_sequence must be a non-negative integer.", CLOSED_LOOP_ERRORS.OBSERVER_INVALID);
  }
  return Object.freeze({
    thread_id: thread,
    after_turn_id: optionalText(afterTurn, "expected.after_turn_id"),
    turn_id: optionalText(turnId, "expected.turn_id"),
    prompt,
    submission_id: optionalText(submissionId, "expected.submission_id"),
    after_sequence: afterSequence,
  });
}

function assertCompletedTurnExpectation(observation, expected) {
  if (!observation || observation.kind !== "TURN_COMPLETED") return false;
  if (observation.thread_id !== expected.thread_id) return false;
  if (expected.turn_id !== null && observation.turn_id !== expected.turn_id) return false;
  if (expected.after_turn_id !== null && observation.turn_id === expected.after_turn_id) return false;
  // A sequence checkpoint is useful within one live app-server stream, but it
  // is not a durable identity across reconnect/restart.  Once an exact prior
  // turn id is supplied, identity + exact prompt (and submission id when the
  // server exposes one) carry the causal boundary without arrival-order
  // guessing.
  if (expected.after_sequence !== null && expected.after_turn_id === null && (observation.sequence === null || observation.sequence <= expected.after_sequence)) return false;
  if (expected.prompt !== null && observation.user_prompt !== expected.prompt) return false;
  if (expected.submission_id !== null && observation.submission_id !== null && observation.submission_id !== expected.submission_id) return false;
  if (expected.submission_id !== null && observation.submission_id === null && expected.prompt === null) return false;
  return true;
}

class NativeAppServerConnection {
  constructor({ command, args, cwd, spawnProcess = spawn, timeoutMs = 30000, onNotification } = {}) {
    this.command = requiredText(command, "app-server command", CLOSED_LOOP_ERRORS.OBSERVER_REQUIRED);
    this.args = Array.isArray(args) ? [...args] : [];
    this.cwd = requiredText(cwd, "app-server cwd", CLOSED_LOOP_ERRORS.OBSERVER_REQUIRED);
    this.spawnProcess = spawnProcess;
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 30000);
    this.onNotification = onNotification;
    this.child = null;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.stderr = "";
  }

  start() {
    if (this.child) return;
    let child;
    try {
      child = this.spawnProcess(this.command, this.args, { cwd: this.cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      throw new ClosedLoopError("Could not start the bound Codex app-server.", CLOSED_LOOP_ERRORS.OBSERVER_DISCONNECTED, error);
    }
    if (!child || !child.stdout || !child.stdin) throw new ClosedLoopError("Bound Codex app-server process adapter is invalid.", CLOSED_LOOP_ERRORS.OBSERVER_INVALID);
    this.child = child;
    child.stdout.on("data", (chunk) => this.#onStdout(chunk));
    child.stderr?.on("data", (chunk) => {
      this.stderr += chunk.toString();
      if (Buffer.byteLength(this.stderr, "utf8") > MAX_MESSAGE_BYTES) this.stderr = this.stderr.slice(-MAX_MESSAGE_BYTES);
    });
    child.on("error", (error) => this.#failPending(new ClosedLoopError("Codex app-server disconnected.", CLOSED_LOOP_ERRORS.OBSERVER_DISCONNECTED, error)));
    child.on("close", () => this.#failPending(new ClosedLoopError("Codex app-server disconnected.", CLOSED_LOOP_ERRORS.OBSERVER_DISCONNECTED)));
  }

  #onStdout(chunk) {
    this.buffer += chunk.toString();
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_APP_SERVER_FRAME_BYTES) {
        this.#failPending(new ClosedLoopError(`Codex app-server emitted an unbounded JSONL frame (${Buffer.byteLength(line, "utf8")} bytes).`, CLOSED_LOOP_ERRORS.OBSERVER_INVALID));
        this.buffer = "";
        return;
      }
      let message;
      try { message = JSON.parse(line); }
      catch (error) {
        this.#failPending(new ClosedLoopError("Codex app-server emitted malformed JSON.", CLOSED_LOOP_ERRORS.OBSERVER_INVALID, error));
        continue;
      }
      if (isObject(message) && hasOwn(message, "id") && (hasOwn(message, "result") || hasOwn(message, "error"))) {
        const pending = this.pending.get(String(message.id));
        if (!pending) continue;
        this.pending.delete(String(message.id));
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new ClosedLoopError("Codex app-server request failed.", CLOSED_LOOP_ERRORS.OBSERVER_INVALID, message.error));
        else pending.resolve(message.result);
      } else {
        try { this.onNotification?.(message); }
        catch (error) { this.#failPending(error); }
      }
    }
    // A burst of many bounded notifications may arrive in one data chunk;
    // only an incomplete individual frame is unbounded at this boundary.
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_APP_SERVER_FRAME_BYTES) {
      const methods = [...this.pending.values()].map((pending) => pending.method).filter(Boolean).join(",");
      this.#failPending(new ClosedLoopError(`Codex app-server emitted an unbounded JSONL frame (${Buffer.byteLength(this.buffer, "utf8")} bytes; pending=${methods || "notification"}).`, CLOSED_LOOP_ERRORS.OBSERVER_INVALID));
      this.buffer = "";
    }
  }

  #failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  notify(method, params = null) {
    if (this.closed) throw new ClosedLoopError("Codex app-server connection is closed.", CLOSED_LOOP_ERRORS.OBSERVER_DISCONNECTED);
    this.start();
    const message = { jsonrpc: "2.0", method };
    if (params !== null && params !== undefined) message.params = params;
    try { this.child.stdin.write(`${JSON.stringify(message)}\n`); }
    catch (error) { throw new ClosedLoopError("Could not write to Codex app-server.", CLOSED_LOOP_ERRORS.OBSERVER_DISCONNECTED, error); }
  }

  request(method, params = null) {
    if (this.closed) return Promise.reject(new ClosedLoopError("Codex app-server connection is closed.", CLOSED_LOOP_ERRORS.OBSERVER_DISCONNECTED));
    this.start();
    const id = String(this.nextId++);
    const message = { jsonrpc: "2.0", id, method };
    if (params !== null && params !== undefined) message.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ClosedLoopError(`Codex app-server request timed out: ${method}.`, CLOSED_LOOP_ERRORS.OBSERVER_TIMEOUT));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.child.stdin.write(`${JSON.stringify(message)}\n`); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new ClosedLoopError("Could not write to Codex app-server.", CLOSED_LOOP_ERRORS.OBSERVER_DISCONNECTED, error));
      }
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.#failPending(new ClosedLoopError("Codex app-server connection closed.", CLOSED_LOOP_ERRORS.OBSERVER_DISCONNECTED));
    try { this.child?.stdin?.end(); } catch {}
    try { this.child?.kill(); } catch {}
  }
}

function extractTurnsFromResume(result) {
  const thread = result?.thread || result?.result?.thread || null;
  if (Array.isArray(thread?.turns)) return thread.turns;
  if (Array.isArray(result?.turns)) return result.turns;
  if (Array.isArray(result?.result?.turns)) return result.result.turns;
  return [];
}

function extractTurnPage(result) {
  const data = result?.data || result?.turns || result?.result?.data || result?.result?.turns || result?.result?.result?.data || result?.result?.result?.turns;
  return Array.isArray(data) ? data : [];
}

function extractNextCursor(result) {
  const cursor = result?.nextCursor || result?.next_cursor || result?.result?.nextCursor || result?.result?.next_cursor || result?.result?.result?.nextCursor || result?.result?.result?.next_cursor;
  return cursor === null || cursor === undefined ? null : requiredText(cursor, "app-server pagination cursor", CLOSED_LOOP_ERRORS.OBSERVER_INVALID);
}

function turnEntryId(value) {
  if (!isObject(value)) return null;
  return value.id || value.turnId || value.turn_id || null;
}

function extractItemPage(result) {
  const data = result?.data || result?.items || result?.result?.data || result?.result?.items || result?.result?.result?.data || result?.result?.result?.items;
  return Array.isArray(data) ? data.map((entry) => {
    if (!isObject(entry)) return null;
    return isObject(entry.item) ? entry.item : null;
  }).filter((item) => item !== null) : [];
}

function errorText(error) {
  const values = [
    error?.message,
    error?.cause?.message,
    error?.cause?.error?.message,
    error?.cause?.data?.message,
  ];
  return values.filter((value) => typeof value === "string").join(" | ");
}

function isActiveWriterConflict(error, expectedThread = null) {
  const text = errorText(error);
  if (!/already has an active writer/i.test(text)) return false;
  if (expectedThread && /thread\s+([0-9a-f-]{36})/i.test(text) && !text.includes(expectedThread)) return false;
  return true;
}

function pageThreadId(result) {
  if (!isObject(result)) return null;
  return threadIdFrom(result) || threadIdFrom(result.result) || threadIdFrom(result.result?.result);
}

function mergeTurnItems(...pages) {
  const merged = [];
  const seen = new Set();
  for (const page of pages) {
    for (const item of page) {
      if (!isObject(item)) continue;
      const key = item.id || canonicalJson(item);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  return merged;
}

function trimMap(map, maxEntries) {
  while (map.size > maxEntries) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

/**
 * Parent-owned exact-thread observer. It uses the bound executable directly
 * and `thread/resume`; no PATH lookup, --last, fuzzy session, or transcript
 * arrival order is involved.
 */
export function createCodexAppServerTurnObserver({
  continuationBinding,
  binding,
  codexContinuationBinding,
  runtimeBinding,
  runtime,
  connectionFactory = null,
  spawnProcess = spawn,
  requestTimeoutMs = 30000,
  turnTimeoutMs = 10 * 60 * 1000,
  compactHistory = false,
  historyPageSize = 128,
  historyPageLimit = 128,
  itemPageSize = 128,
  now = () => new Date().toISOString(),
} = {}) {
  const continuation = validateCodexContinuationBinding(continuationBinding || binding || codexContinuationBinding);
  const runtimeValue = validateCodexRuntimeBinding(runtimeBinding || runtime);
  if (!runtimeValue.capabilities.queue) throw new ClosedLoopError("Bound runtime must expose queue capability.", CLOSED_LOOP_ERRORS.RUNTIME_INVALID);
  const expectedThread = continuation.thread_id;
  let connection = null;
  let initialized = false;
  let sequence = 0;
  let itemByTurn = new Map();
  let completedByTurn = new Map();
  let pendingWaiters = new Set();
  let readOnly = false;
  const useCompactHistory = compactHistory === true;
  const boundedHistoryPageSize = Number.isInteger(historyPageSize) && historyPageSize > 0 && historyPageSize <= MAX_OBSERVER_TURNS ? historyPageSize : 128;
  const boundedHistoryPageLimit = Number.isInteger(historyPageLimit) && historyPageLimit > 0 && historyPageLimit <= MAX_OBSERVER_TURNS ? historyPageLimit : 128;
  const boundedItemPageSize = Number.isInteger(itemPageSize) && itemPageSize > 0 && itemPageSize <= MAX_OBSERVER_ITEMS_PER_TURN ? itemPageSize : 128;

  const listTurnEntries = async (current, { stopAtTurnId = null } = {}) => {
    const entries = [];
    const seen = new Set();
    let cursor = null;
    for (let pageIndex = 0; pageIndex < boundedHistoryPageLimit; pageIndex += 1) {
      const page = await current.request(CODEX_APP_SERVER_METHODS.THREAD_TURNS_LIST, {
        threadId: expectedThread,
        cursor,
        limit: boundedHistoryPageSize,
        sortDirection: "asc",
        itemsView: "notLoaded",
      });
      const listedThread = pageThreadId(page);
      if (listedThread !== null && listedThread !== expectedThread) throw new ClosedLoopError("Codex turn history returned a different thread.", CLOSED_LOOP_ERRORS.WRONG_THREAD);
      const pageEntries = extractTurnPage(page);
      for (const entry of pageEntries) {
        const id = turnEntryId(entry);
        if (id === null) continue;
        if (!seen.has(id)) {
          seen.add(id);
          entries.push(entry);
        }
        if (stopAtTurnId !== null && id === stopAtTurnId) return Object.freeze({ entries: Object.freeze(entries), found: entry });
      }
      const next = extractNextCursor(page);
      if (next === null || next === cursor) break;
      cursor = next;
    }
    return Object.freeze({ entries: Object.freeze(entries), found: null });
  };

  const hydrateTurnEntry = async (current, entry) => {
    const turnId = turnEntryId(entry);
    if (turnId === null) throw new ClosedLoopError("Codex turn history entry has no exact turn id.", CLOSED_LOOP_ERRORS.TURN_INVALID);
    const pages = [];
    for (const sortDirection of ["asc", "desc"]) {
      let cursor = null;
      const directionPages = [];
      for (let pageIndex = 0; pageIndex < boundedHistoryPageLimit; pageIndex += 1) {
        const page = await current.request(CODEX_APP_SERVER_METHODS.THREAD_ITEMS_LIST, {
          threadId: expectedThread,
          turnId,
          cursor,
          limit: boundedItemPageSize,
          sortDirection,
        });
        const listedThread = pageThreadId(page);
        if (listedThread !== null && listedThread !== expectedThread) throw new ClosedLoopError("Codex turn items returned a different thread.", CLOSED_LOOP_ERRORS.WRONG_THREAD);
        directionPages.push(extractItemPage(page));
        const next = extractNextCursor(page);
        if (next === null || next === cursor) break;
        cursor = next;
      }
      pages.push(...directionPages);
    }
    const turn = {
      ...entry,
      id: turnId,
      status: entry.status,
      items: mergeTurnItems(...pages),
    };
    if (turn.status !== "completed") throw new ClosedLoopError("Exact requested Codex turn is not completed.", CLOSED_LOOP_ERRORS.TURN_NOT_COMPLETED);
    return turn;
  };

  const hydrateExactTurn = async (current, turnId) => {
    const listed = await listTurnEntries(current, { stopAtTurnId: turnId });
    if (!listed.found) throw new ClosedLoopError("Exact requested Codex turn was not found in bounded paginated history.", CLOSED_LOOP_ERRORS.TURN_INVALID);
    return hydrateTurnEntry(current, listed.found);
  };

  const findReadOnlyCompletion = async (current, expected) => {
    const listed = await listTurnEntries(current);
    const entries = listed.entries;
    let startIndex = -1;
    if (expected.after_turn_id !== null) {
      startIndex = entries.findIndex((entry) => turnEntryId(entry) === expected.after_turn_id);
      if (startIndex < 0) throw new ClosedLoopError("Exact prior Codex turn was not found in bounded paginated history.", CLOSED_LOOP_ERRORS.TURN_INVALID);
    }
    const candidates = [];
    for (const entry of entries.slice(startIndex + 1)) {
      const id = turnEntryId(entry);
      if (expected.turn_id !== null && id !== expected.turn_id) continue;
      if (entry.status !== "completed") continue;
      let turn;
      try { turn = await hydrateTurnEntry(current, entry); }
      catch (error) {
        if (error?.code === CLOSED_LOOP_ERRORS.TURN_NOT_COMPLETED) continue;
        throw error;
      }
      const observation = normalizeCompletedTurn({ thread_id: expectedThread, turn, source: "durable-history", sequence: null });
      if (assertCompletedTurnExpectation(observation, expected)) candidates.push(observation);
      if (expected.turn_id !== null && candidates.length > 0) break;
    }
    if (candidates.length > 1) throw new ClosedLoopError("Multiple durable Codex turns match the exact continuation expectation.", CLOSED_LOOP_ERRORS.OBSERVER_AMBIGUOUS);
    return candidates[0] || null;
  };

  const notify = (value) => {
    let parsed;
    try {
      parsed = parseCodexAppServerNotification(value, { thread_id: expectedThread, sequence });
    } catch (error) {
      // Some app-server builds emit a compact turn/completed envelope while
      // the canonical agent text is carried by preceding item events.  Keep
      // the strict public parser fail-closed, but let this parent observer
      // reconstruct from those exact same-turn items when available.
      if (eventMethod(value) !== CODEX_APP_SERVER_EVENTS.TURN_COMPLETED) throw error;
      const params = eventParams(value);
      const turn = turnFrom(params);
      const turnId = turnIdFrom(params);
      const items = typeof turnId === "string" ? (itemByTurn.get(turnId) || []) : [];
      try {
        parsed = normalizeCompletedTurn({ thread_id: threadIdFrom(params), turn, event: value, extraItems: items, source: "notification-items", sequence });
      } catch {
        throw error;
      }
    }
    sequence += 1;
    if (parsed.kind === "ITEM_STARTED" || parsed.kind === "ITEM_COMPLETED") {
      const turnId = parsed.turn_id;
      if (typeof turnId === "string") {
        const list = itemByTurn.get(turnId) || [];
        if (list.length < MAX_OBSERVER_ITEMS_PER_TURN) list.push(parsed.item);
        itemByTurn.set(turnId, list);
        trimMap(itemByTurn, MAX_OBSERVER_TURNS);
      }
    }
    let observation = parsed;
    if (parsed.kind === "TURN_COMPLETED") {
      const items = itemByTurn.get(parsed.turn_id) || [];
      if (parsed.user_prompt === null || parsed.causal_proof === "turn_identity_only") {
        observation = normalizeCompletedTurn({ thread_id: parsed.thread_id, turn: { id: parsed.turn_id, status: parsed.turn_status, items: [{ type: "agentMessage", text: parsed.message }, ...items] }, event: value, extraItems: items, source: parsed.source, sequence: parsed.sequence });
      }
      const prior = completedByTurn.get(parsed.turn_id);
      if (prior && prior.source_turn_sha256 !== observation.source_turn_sha256) {
        const error = new ClosedLoopError("The same Codex turn was observed with different bytes.", CLOSED_LOOP_ERRORS.TURN_CONFLICT);
        for (const waiter of pendingWaiters) {
          pendingWaiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.reject(error);
        }
        return;
      }
      completedByTurn.set(parsed.turn_id, observation);
      trimMap(completedByTurn, MAX_OBSERVER_TURNS);
    }
    for (const waiter of [...pendingWaiters]) {
      if (assertCompletedTurnExpectation(observation, waiter.expected)) {
        pendingWaiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(observation);
      }
    }
  };

  const makeConnection = () => {
    if (connection) return connection;
    const args = [...runtimeValue.launch_args, "app-server", "--stdio"];
    if (connectionFactory) {
      connection = connectionFactory({
        command: runtimeValue.executable_path,
        args,
        cwd: continuation.working_directory,
        thread_id: expectedThread,
        runtime: runtimeValue,
        onNotification: notify,
      });
      if (!connection || typeof connection.request !== "function") throw new ClosedLoopError("Observer connectionFactory returned an invalid connection.", CLOSED_LOOP_ERRORS.OBSERVER_INVALID);
      return connection;
    }
    connection = new NativeAppServerConnection({ command: runtimeValue.executable_path, args, cwd: continuation.working_directory, spawnProcess, timeoutMs: requestTimeoutMs, onNotification: notify });
    return connection;
  };

  const ensureResumed = async (expected = null) => {
    await verifyCodexRuntimeBinding(runtimeValue);
    const current = makeConnection();
    if (!initialized) {
      await current.request(CODEX_APP_SERVER_METHODS.INITIALIZE, {
        clientInfo: { name: "devexec-closed-loop", version: "1" },
        capabilities: { experimentalApi: false, optOutNotificationMethods: [] },
      });
      if (typeof current.notify === "function") current.notify(CODEX_APP_SERVER_METHODS.INITIALIZED, null);
      initialized = true;
      let resumed;
      try {
        resumed = await current.request(CODEX_APP_SERVER_METHODS.THREAD_RESUME, { threadId: expectedThread, excludeTurns: useCompactHistory });
      } catch (error) {
        // A task that is already open in the native Codex app owns its
        // thread writer.  Do not steal that writer or create another thread;
        // switch to bounded, exact durable-history polling instead.
        if (!isActiveWriterConflict(error, expectedThread)) throw error;
        readOnly = true;
        if (expected?.turn_id) {
          const turn = await hydrateExactTurn(current, expected.turn_id);
          notify({ method: CODEX_APP_SERVER_EVENTS.TURN_COMPLETED, params: { threadId: expectedThread, turn } });
        }
        return current;
      }
      const resumedThreadId = threadIdFrom(resumed);
      if (resumedThreadId !== null && resumedThreadId !== expectedThread) throw new ClosedLoopError("thread/resume returned a different thread.", CLOSED_LOOP_ERRORS.WRONG_THREAD);
      const turns = useCompactHistory && expected?.turn_id
        ? [await hydrateExactTurn(current, expected.turn_id)]
        : extractTurnsFromResume(resumed);
      const selectedTurns = turns.length <= MAX_OBSERVER_TURNS
        ? turns
        : turns.slice(-MAX_OBSERVER_TURNS).concat(expected?.turn_id ? turns.filter((turn) => turn?.id === expected.turn_id).slice(0, 1) : []);
      const seenTurnIds = new Set();
      for (const turn of selectedTurns) {
        if (turn?.status !== "completed") continue;
        if (seenTurnIds.has(turn.id)) continue;
        seenTurnIds.add(turn.id);
        try {
          notify({ method: CODEX_APP_SERVER_EVENTS.TURN_COMPLETED, params: { threadId: expectedThread, turn } });
        } catch (error) {
          if (error?.code !== CLOSED_LOOP_ERRORS.TURN_NOT_COMPLETED) throw error;
        }
      }
    }
    return current;
  };

  const checkpoint = () => Object.freeze({ sequence, completed_turn_ids: Object.freeze([...completedByTurn.keys()]), at: now() });

  const waitForTurn = async (input = {}) => {
    const expected = normalizeExpected(input, expectedThread);
    if (expected.thread_id !== expectedThread) throw new ClosedLoopError("Observer expectation targets a different thread.", CLOSED_LOOP_ERRORS.WRONG_THREAD);
    await ensureResumed(expected);
    for (const observation of completedByTurn.values()) {
      if (assertCompletedTurnExpectation(observation, expected)) return Object.freeze({ ...observation, idempotent: true });
    }
    const timeout = Number(input.timeout_ms ?? input.timeoutMs ?? turnTimeoutMs);
    if (!Number.isFinite(timeout) || timeout <= 0) throw new ClosedLoopError("Observer timeout must be bounded.", CLOSED_LOOP_ERRORS.OBSERVER_TIMEOUT);
    if (readOnly) {
      const deadline = Date.now() + timeout;
      while (true) {
        const current = makeConnection();
        const observation = await findReadOnlyCompletion(current, expected);
        if (observation) {
          const prior = completedByTurn.get(observation.turn_id);
          if (prior && prior.source_turn_sha256 !== observation.source_turn_sha256) throw new ClosedLoopError("The same Codex turn was observed with different bytes.", CLOSED_LOOP_ERRORS.TURN_CONFLICT);
          completedByTurn.set(observation.turn_id, observation);
          trimMap(completedByTurn, MAX_OBSERVER_TURNS);
          return observation;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new ClosedLoopError("Exact Codex turn completion was not observed within the bound.", CLOSED_LOOP_ERRORS.OBSERVER_TIMEOUT);
        await sleep(Math.min(1000, remaining));
      }
    }
    return new Promise((resolve, reject) => {
      const waiter = { expected, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        pendingWaiters.delete(waiter);
        reject(new ClosedLoopError("Exact Codex turn completion was not observed within the bound.", CLOSED_LOOP_ERRORS.OBSERVER_TIMEOUT));
      }, timeout);
      pendingWaiters.add(waiter);
    });
  };

  const reconnect = () => {
    try { connection?.close?.(); } finally {
      connection = null;
      initialized = false;
      itemByTurn = new Map();
      readOnly = false;
    }
    return Object.freeze({ status: "RECONNECT_READY", thread_id: expectedThread });
  };

  const close = () => {
    for (const waiter of pendingWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new ClosedLoopError("Exact Codex observer closed.", CLOSED_LOOP_ERRORS.OBSERVER_DISCONNECTED));
    }
    pendingWaiters.clear();
    connection?.close?.();
    connection = null;
    initialized = false;
    readOnly = false;
  };

  return Object.freeze({
    thread_id: expectedThread,
    continuation_binding: continuation,
    runtime_binding: runtimeValue,
    waitForTurn,
    wait: waitForTurn,
    observe: waitForTurn,
    checkpoint,
    reconnect,
    close,
    inspect: () => Object.freeze({ thread_id: expectedThread, sequence, initialized, read_only: readOnly, completed_turn_ids: Object.freeze([...completedByTurn.keys()]) }),
  });
}

export const createCodexTurnObserver = createCodexAppServerTurnObserver;
export const createNativeCodexTurnObserver = createCodexAppServerTurnObserver;
export const createExactCodexTurnObserver = createCodexAppServerTurnObserver;

class JsonFileStore {
  constructor({ root, kind, now }) {
    if (root === undefined || root === null) throw new ClosedLoopError(`${kind} root is required.`, CLOSED_LOOP_ERRORS.REQUIRED);
    this.root = path.resolve(root);
    this.dir = path.join(this.root, `${kind}-v1`);
    this.now = now;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  filePathFor(identity) {
    return path.join(this.dir, `${digestValue(identity).slice("sha256:".length)}.json`);
  }

  read(filePath) {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) throw new ClosedLoopError("Persisted loop file is not a bounded regular file.", CLOSED_LOOP_ERRORS.STATE_INVALID);
    try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
    catch (error) { throw new ClosedLoopError("Persisted loop JSON is invalid.", CLOSED_LOOP_ERRORS.STATE_INVALID, error); }
  }

  write(filePath, value) {
    const temp = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    const content = `${canonicalJson(value)}\n`;
    try {
      const fd = fs.openSync(temp, "wx");
      try { fs.writeFileSync(fd, content, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, filePath);
    } catch (error) {
      try { fs.unlinkSync(temp); } catch {}
      throw error;
    }
  }
}

function normalizeLimits(value = {}) {
  if (!isObject(value)) throw new ClosedLoopError("limits must be an object.", CLOSED_LOOP_ERRORS.LIMIT_INVALID);
  const maxRounds = Number(value.max_rounds ?? value.maxRounds);
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 20) throw new ClosedLoopError("max_rounds must be an integer between 1 and 20.", CLOSED_LOOP_ERRORS.LIMIT_INVALID);
  const turnTimeout = Number(value.turn_timeout_ms ?? value.turnTimeoutMs ?? 10 * 60 * 1000);
  if (!Number.isInteger(turnTimeout) || turnTimeout < 1 || turnTimeout > 24 * 60 * 60 * 1000) throw new ClosedLoopError("turn_timeout_ms is outside the bounded range.", CLOSED_LOOP_ERRORS.LIMIT_INVALID);
  const chatTimeout = Number(value.chatgpt_timeout_ms ?? value.chatGPTTimeoutMs ?? 30 * 60 * 1000);
  if (!Number.isInteger(chatTimeout) || chatTimeout < 1 || chatTimeout > 120 * 60 * 1000) throw new ClosedLoopError("chatgpt_timeout_ms is outside the bounded range.", CLOSED_LOOP_ERRORS.LIMIT_INVALID);
  const localTimeout = Number(value.local_relay_timeout_ms ?? value.localRelayTimeoutMs ?? 30 * 1000);
  if (!Number.isInteger(localTimeout) || localTimeout < 1 || localTimeout > 120 * 1000) throw new ClosedLoopError("local_relay_timeout_ms is outside the bounded range.", CLOSED_LOOP_ERRORS.LIMIT_INVALID);
  const wall = value.wall_clock_budget_ms ?? value.wallClockBudgetMs ?? null;
  if (wall !== null && (!Number.isInteger(Number(wall)) || Number(wall) < 1 || Number(wall) > 7 * 24 * 60 * 60 * 1000)) throw new ClosedLoopError("wall_clock_budget_ms is outside the bounded range.", CLOSED_LOOP_ERRORS.LIMIT_INVALID);
  return Object.freeze({ max_rounds: maxRounds, turn_timeout_ms: turnTimeout, chatgpt_timeout_ms: chatTimeout, local_relay_timeout_ms: localTimeout, wall_clock_budget_ms: wall === null ? null : Number(wall) });
}

export const validateClosedLoopLimits = normalizeLimits;

function validateHistory(history) {
  if (!Array.isArray(history) || history.length > MAX_HISTORY) throw new ClosedLoopError("loop history is invalid or unbounded.", CLOSED_LOOP_ERRORS.STATE_INVALID);
  return history.map((entry) => {
    if (!isObject(entry)) throw new ClosedLoopError("loop history entry must be an object.", CLOSED_LOOP_ERRORS.STATE_INVALID);
    const allowed = ["round_index", "source_turn_id", "source_turn_sha256", "report_sha256", "relay_request_id", "decision", "codex_return_id", "submission_id", "resulting_turn_id", "resulting_turn_sha256"];
    for (const key of Object.keys(entry)) if (!allowed.includes(key)) throw new ClosedLoopError(`Unknown loop history field: ${key}.`, CLOSED_LOOP_ERRORS.STATE_INVALID);
    if (!Number.isInteger(entry.round_index) || entry.round_index < 0 || entry.round_index > 20) throw new ClosedLoopError("loop history round_index is invalid.", CLOSED_LOOP_ERRORS.STATE_INVALID);
    for (const key of ["source_turn_id", "source_turn_sha256", "report_sha256", "relay_request_id", "decision"]) {
      boundedText(requiredText(entry[key], `history.${key}`, CLOSED_LOOP_ERRORS.STATE_INVALID), `history.${key}`, MAX_MESSAGE_BYTES, { required: true });
    }
    if (!["CONTINUE", "STOP", "NEEDS_HUMAN"].includes(entry.decision)) throw new ClosedLoopError("loop history decision is invalid.", CLOSED_LOOP_ERRORS.STATE_INVALID);
    for (const key of ["source_turn_sha256", "report_sha256", "relay_request_id"]) if (!isDigest(entry[key])) throw new ClosedLoopError(`history.${key} must be a sha256 digest.`, CLOSED_LOOP_ERRORS.STATE_INVALID);
    for (const key of ["codex_return_id", "submission_id", "resulting_turn_id", "resulting_turn_sha256"]) {
      const optional = optionalText(entry[key] ?? null, `history.${key}`, CLOSED_LOOP_ERRORS.STATE_INVALID);
      if (optional !== null) boundedText(optional, `history.${key}`, MAX_MESSAGE_BYTES, { required: true });
    }
    if (entry.resulting_turn_sha256 !== null && !isDigest(entry.resulting_turn_sha256)) throw new ClosedLoopError("history.resulting_turn_sha256 must be a sha256 digest.", CLOSED_LOOP_ERRORS.STATE_INVALID);
    return Object.freeze({ ...entry });
  });
}

function validateLoopState(value) {
  if (!isObject(value)) throw new ClosedLoopError("Loop state must be an object.", CLOSED_LOOP_ERRORS.STATE_INVALID);
  for (const key of Object.keys(value)) if (!LOOP_STATE_FIELDS.has(key)) throw new ClosedLoopError(`Unknown loop state field: ${key}.`, CLOSED_LOOP_ERRORS.STATE_INVALID);
  for (const key of ["protocol", "loop_id", "mission_id", "task_id", "task_chat_binding_id", "conversation_id", "codex_continuation_binding_id", "codex_runtime_binding_id", "codex_runtime_fingerprint", "thread_id", "phase", "created_at", "updated_at"]) requiredText(value[key], `state.${key}`, CLOSED_LOOP_ERRORS.STATE_INVALID);
  if (value.protocol !== CLOSED_LOOP_PROTOCOL || value.schema_version !== CLOSED_LOOP_SCHEMA_VERSION) throw new ClosedLoopError("Unsupported closed-loop state protocol.", CLOSED_LOOP_ERRORS.STATE_INVALID);
  if (!Object.values(CLOSED_LOOP_PHASES).includes(value.phase)) throw new ClosedLoopError("Closed-loop state phase is invalid.", CLOSED_LOOP_ERRORS.STATE_INVALID);
  const limits = normalizeLimits(value.limits);
  if (!Number.isInteger(value.round_index) || value.round_index < 0 || value.round_index > limits.max_rounds) throw new ClosedLoopError("state.round_index is invalid.", CLOSED_LOOP_ERRORS.STATE_INVALID);
  for (const key of ["last_observed_turn_id", "last_observed_turn_sha256", "last_observed_turn_status", "last_observed_causal_proof", "current_relay_request_id", "current_report_sha256", "expected_after_turn_id", "expected_prompt_sha256", "expected_submission_id", "error_code"]) optionalText(value[key] ?? null, `state.${key}`, CLOSED_LOOP_ERRORS.STATE_INVALID);
  nullableBoundedText(value.last_observed_message, "state.last_observed_message", MAX_MESSAGE_BYTES);
  nullableBoundedText(value.expected_prompt, "state.expected_prompt", MAX_PROMPT_BYTES);
  nullableBoundedText(value.terminal_reason, "state.terminal_reason", MAX_MESSAGE_BYTES);
  nullableBoundedText(value.error_message, "state.error_message", MAX_MESSAGE_BYTES);
  for (const key of ["last_observed_turn_sha256", "current_relay_request_id", "current_report_sha256", "expected_prompt_sha256"]) if (value[key] !== null && !isDigest(value[key])) throw new ClosedLoopError(`state.${key} must be a sha256 digest.`, CLOSED_LOOP_ERRORS.STATE_INVALID);
  if (value.last_observed_turn_id === null && value.last_observed_turn_sha256 !== null) throw new ClosedLoopError("state.last_observed_turn_sha256 requires last_observed_turn_id.", CLOSED_LOOP_ERRORS.STATE_INVALID);
  if (value.last_observed_turn_id !== null && value.last_observed_turn_sha256 === null) throw new ClosedLoopError("state.last_observed_turn_id requires last_observed_turn_sha256.", CLOSED_LOOP_ERRORS.STATE_INVALID);
  if (value.last_observed_turn_status !== null && value.last_observed_turn_status !== "completed") throw new ClosedLoopError("state.last_observed_turn_status must be completed.", CLOSED_LOOP_ERRORS.STATE_INVALID);
  if (value.last_observed_message !== null) boundedText(value.last_observed_message, "state.last_observed_message", MAX_MESSAGE_BYTES, { required: true });
  if (value.expected_prompt !== null) boundedText(value.expected_prompt, "state.expected_prompt", MAX_PROMPT_BYTES, { required: true });
  if (value.expected_prompt === null && value.expected_prompt_sha256 !== null) throw new ClosedLoopError("state.expected_prompt_sha256 requires expected_prompt.", CLOSED_LOOP_ERRORS.STATE_INVALID);
  if (value.expected_prompt !== null && (value.expected_prompt_sha256 === null || sha256(value.expected_prompt) !== value.expected_prompt_sha256)) throw new ClosedLoopError("state.expected_prompt_sha256 does not match expected_prompt.", CLOSED_LOOP_ERRORS.STATE_INVALID);
  if (value.current_report !== null && !isObject(value.current_report)) throw new ClosedLoopError("state.current_report must be an object or null.", CLOSED_LOOP_ERRORS.STATE_INVALID);
  if (value.current_report === null && value.current_report_sha256 !== null) throw new ClosedLoopError("state.current_report_sha256 requires current_report.", CLOSED_LOOP_ERRORS.STATE_INVALID);
  if (value.current_report !== null) {
    const reportBytes = canonicalJson(value.current_report);
    if (Buffer.byteLength(reportBytes, "utf8") > MAX_MESSAGE_BYTES) throw new ClosedLoopError("state.current_report is too large.", CLOSED_LOOP_ERRORS.STATE_INVALID);
    if (value.current_report_sha256 === null || hashJson(value.current_report) !== value.current_report_sha256) throw new ClosedLoopError("state.current_report_sha256 does not match current_report.", CLOSED_LOOP_ERRORS.STATE_INVALID);
  }
  if (value.observer_checkpoint !== null && !isObject(value.observer_checkpoint)) throw new ClosedLoopError("state.observer_checkpoint is invalid.", CLOSED_LOOP_ERRORS.STATE_INVALID);
  if (value.observer_checkpoint !== null && Buffer.byteLength(canonicalJson(value.observer_checkpoint), "utf8") > MAX_MESSAGE_BYTES) throw new ClosedLoopError("state.observer_checkpoint is too large.", CLOSED_LOOP_ERRORS.STATE_INVALID);
  if (value.expected_observer_sequence !== null && (!Number.isInteger(value.expected_observer_sequence) || value.expected_observer_sequence < 0)) throw new ClosedLoopError("state.expected_observer_sequence is invalid.", CLOSED_LOOP_ERRORS.STATE_INVALID);
  if (value.pending_history !== null) {
    if (!isObject(value.pending_history)) throw new ClosedLoopError("state.pending_history is invalid.", CLOSED_LOOP_ERRORS.STATE_INVALID);
    const pending = validateHistory([value.pending_history])[0];
    if (pending.decision !== "CONTINUE" || pending.resulting_turn_id !== null || pending.resulting_turn_sha256 !== null) throw new ClosedLoopError("state.pending_history must be an unresolved CONTINUE entry.", CLOSED_LOOP_ERRORS.STATE_INVALID);
  }
  validateHistory(value.history);
  return cloneFrozen({ ...value, limits, history: value.history.map((entry) => ({ ...entry })) });
}

export const validateClosedLoopState = validateLoopState;

/** Parent-owned atomic state for one immutable loop/thread lineage. */
export function createClosedLoopStateStore({ stateDir, directory, now = () => new Date().toISOString() } = {}) {
  const root = stateDir ?? directory;
  const base = new JsonFileStore({ root, kind: "loops", now });
  const filePathFor = (loopId) => base.filePathFor(requiredText(loopId, "loop_id"));
  const load = (loopId) => {
    const filePath = filePathFor(loopId);
    if (!fs.existsSync(filePath)) return null;
    return validateLoopState(base.read(filePath));
  };
  const create = (input = {}) => {
    const state = validateLoopState({
      protocol: CLOSED_LOOP_PROTOCOL,
      schema_version: CLOSED_LOOP_SCHEMA_VERSION,
      ...input,
      phase: input.phase || CLOSED_LOOP_PHASES.READY,
      round_index: input.round_index ?? 0,
      last_observed_turn_id: input.last_observed_turn_id ?? null,
      last_observed_turn_sha256: input.last_observed_turn_sha256 ?? null,
      last_observed_turn_status: input.last_observed_turn_status ?? null,
      last_observed_message: input.last_observed_message ?? null,
      last_observed_causal_proof: input.last_observed_causal_proof ?? null,
      current_relay_request_id: input.current_relay_request_id ?? null,
      current_report: input.current_report ?? null,
      current_report_sha256: input.current_report_sha256 ?? null,
      expected_after_turn_id: input.expected_after_turn_id ?? null,
      expected_prompt: input.expected_prompt ?? null,
      expected_prompt_sha256: input.expected_prompt_sha256 ?? null,
      expected_submission_id: input.expected_submission_id ?? null,
      expected_observer_sequence: input.expected_observer_sequence ?? null,
      observer_checkpoint: input.observer_checkpoint ?? null,
      pending_history: input.pending_history ?? null,
      history: input.history ?? [],
      terminal_reason: input.terminal_reason ?? null,
      error_code: input.error_code ?? null,
      error_message: input.error_message ?? null,
      created_at: input.created_at || now(),
      updated_at: input.updated_at || now(),
    });
    const filePath = filePathFor(state.loop_id);
    try {
      const fd = fs.openSync(filePath, "wx");
      try { fs.writeFileSync(fd, `${canonicalJson(state)}\n`, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      return state;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = load(state.loop_id);
      if (!existing) throw new ClosedLoopError("Loop state disappeared during duplicate admission.", CLOSED_LOOP_ERRORS.STATE_INVALID);
      compareLoopImmutable(state, existing);
      return existing;
    }
  };
  const lockPathFor = (loopId) => `${filePathFor(loopId)}.lock`;
  const update = (loopId, patchOrUpdater, { expectedPhase = null } = {}) => {
    const filePath = filePathFor(loopId);
    const current = load(loopId);
    if (!current) throw new ClosedLoopError("Loop state is missing; success cannot be inferred.", CLOSED_LOOP_ERRORS.STATE_INVALID);
    const lockPath = lockPathFor(loopId);
    let fd;
    try { fd = fs.openSync(lockPath, "wx"); }
    catch (error) {
      if (error?.code === "EEXIST") throw new ClosedLoopError("Loop state is being updated by another process.", CLOSED_LOOP_ERRORS.STATE_BUSY);
      throw error;
    }
    try {
      const locked = load(loopId);
      if (!locked) throw new ClosedLoopError("Loop state disappeared while locked.", CLOSED_LOOP_ERRORS.STATE_INVALID);
      if (expectedPhase !== null && !(Array.isArray(expectedPhase) ? expectedPhase : [expectedPhase]).includes(locked.phase)) return locked;
      const patch = typeof patchOrUpdater === "function" ? patchOrUpdater(locked) : patchOrUpdater;
      if (!isObject(patch)) throw new ClosedLoopError("Loop state patch must be an object.", CLOSED_LOOP_ERRORS.INVALID);
      const next = validateLoopState({ ...locked, ...patch, updated_at: now() });
      compareLoopImmutable(locked, next);
      base.write(filePath, next);
      return next;
    } finally {
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(lockPath); } catch {}
    }
  };
  return Object.freeze({ stateDir: base.root, loopsDir: base.dir, filePathFor, load, create, update });
}

export const createClosedLoopRunStateStore = createClosedLoopStateStore;

function compareLoopImmutable(expected, actual) {
  for (const key of ["loop_id", "mission_id", "task_id", "task_chat_binding_id", "conversation_id", "codex_continuation_binding_id", "codex_runtime_binding_id", "codex_runtime_fingerprint", "thread_id"]) {
    if (expected[key] !== actual[key]) throw new ClosedLoopError(`${key} does not match persisted loop identity.`, CLOSED_LOOP_ERRORS.IDENTITY_MISMATCH);
  }
  if (canonicalJson(expected.limits) !== canonicalJson(actual.limits)) throw new ClosedLoopError("Loop limits do not match persisted loop identity.", CLOSED_LOOP_ERRORS.IDENTITY_MISMATCH);
}

/** Exclusive cross-process lease keyed by loop/thread lineage. Invalid records cannot be stolen. */
export function createClosedLoopOwnerLease({ stateDir, directory, owner_id, ownerId, now = () => new Date().toISOString() } = {}) {
  const root = stateDir ?? directory;
  if (root === undefined || root === null) throw new ClosedLoopError("Owner lease directory is required.", CLOSED_LOOP_ERRORS.REQUIRED);
  const dir = path.join(path.resolve(root), "loop-owners-v1");
  fs.mkdirSync(dir, { recursive: true });
  const owner = requiredText(owner_id || ownerId || `${os.hostname()}:${process.pid}:${crypto.randomBytes(8).toString("hex")}`, "owner_id", CLOSED_LOOP_ERRORS.OWNER_REQUIRED);
  const filePathFor = (loopId, threadId) => path.join(dir, `${digestValue({ loop_id: requiredText(loopId, "loop_id"), thread_id: requiredText(threadId, "thread_id") }).slice("sha256:".length)}.json`);
  const read = (filePath) => {
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) return null;
      const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (!isObject(value) || Object.keys(value).some((key) => !OWNER_FIELDS.includes(key)) || OWNER_FIELDS.some((key) => !hasOwn(value, key))) return null;
      requiredText(value.protocol, "owner.protocol", CLOSED_LOOP_ERRORS.OWNER_INVALID);
      if (value.protocol !== `${CLOSED_LOOP_PROTOCOL}.owner` || value.schema_version !== 1) return null;
      requiredText(value.lineage_sha256, "owner.lineage_sha256", CLOSED_LOOP_ERRORS.OWNER_INVALID);
      requiredText(value.loop_id, "owner.loop_id", CLOSED_LOOP_ERRORS.OWNER_INVALID);
      requiredText(value.thread_id, "owner.thread_id", CLOSED_LOOP_ERRORS.OWNER_INVALID);
      requiredText(value.owner_id, "owner.owner_id", CLOSED_LOOP_ERRORS.OWNER_INVALID);
      requiredText(value.nonce, "owner.nonce", CLOSED_LOOP_ERRORS.OWNER_INVALID);
      requiredText(value.acquired_at, "owner.acquired_at", CLOSED_LOOP_ERRORS.OWNER_INVALID);
      return cloneFrozen(value);
    } catch { return null; }
  };
  const acquire = ({ loop_id, loopId, thread_id, threadId } = {}) => {
    const loop = requiredText(loop_id || loopId, "loop_id");
    const thread = requiredText(thread_id || threadId, "thread_id");
    const filePath = filePathFor(loop, thread);
    const record = { protocol: `${CLOSED_LOOP_PROTOCOL}.owner`, schema_version: 1, lineage_sha256: digestValue({ loop_id: loop, thread_id: thread }), loop_id: loop, thread_id: thread, owner_id: owner, nonce: `owner-${crypto.randomBytes(12).toString("hex")}`, acquired_at: now() };
    try {
      const fd = fs.openSync(filePath, "wx");
      try { fs.writeFileSync(fd, `${canonicalJson(record)}\n`, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const handle = Object.freeze({ filePath, record: cloneFrozen(record), release: () => release(handle) });
      return Object.freeze({ status: "ACQUIRED", handle, owner_id: owner });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = read(filePath);
      if (!existing) return Object.freeze({ status: "OWNER_INVALID", code: CLOSED_LOOP_ERRORS.OWNER_INVALID });
      if (existing.loop_id !== loop || existing.thread_id !== thread) return Object.freeze({ status: "OWNER_INVALID", code: CLOSED_LOOP_ERRORS.OWNER_INVALID });
      if (existing.owner_id === owner) {
        const handle = Object.freeze({ filePath, record: existing, release: () => release(handle) });
        return Object.freeze({ status: "ACQUIRED", reentrant: true, handle, owner_id: owner });
      }
      return Object.freeze({ status: "OWNER_HELD", holder: existing, code: CLOSED_LOOP_ERRORS.OWNER_HELD });
    }
  };
  const release = (handle) => {
    if (!handle || !isObject(handle.record) || typeof handle.filePath !== "string") throw new ClosedLoopError("Owner lease handle is invalid.", CLOSED_LOOP_ERRORS.OWNER_INVALID);
    const current = read(handle.filePath);
    if (!current || canonicalJson(current) !== canonicalJson(handle.record)) throw new ClosedLoopError("Owner lease no longer matches its handle.", CLOSED_LOOP_ERRORS.OWNER_INVALID);
    try { fs.unlinkSync(handle.filePath); } catch (error) { if (error?.code !== "ENOENT") throw new ClosedLoopError("Owner lease could not be released.", CLOSED_LOOP_ERRORS.OWNER_INVALID, error); }
    return Object.freeze({ status: "RELEASED", loop_id: handle.record.loop_id, thread_id: handle.record.thread_id });
  };
  const inspect = (loopId, threadId) => {
    const filePath = filePathFor(loopId, threadId);
    return fs.existsSync(filePath) ? read(filePath) : null;
  };
  return Object.freeze({ owner_id: owner, ownerDir: dir, filePathFor, acquire, release, inspect });
}

export const createClosedLoopLease = createClosedLoopOwnerLease;

function resolveObserver(observer, observerFactory, context) {
  const value = observer || (typeof observerFactory === "function" ? observerFactory(context) : null);
  if (!value) throw new ClosedLoopError("An exact Codex turn observer is required.", CLOSED_LOOP_ERRORS.OBSERVER_REQUIRED);
  const wait = value.waitForTurn || value.wait || value.observe;
  if (typeof wait !== "function") throw new ClosedLoopError("Codex turn observer lacks waitForTurn().", CLOSED_LOOP_ERRORS.OBSERVER_INVALID);
  return { value, wait: wait.bind(value), checkpoint: typeof value.checkpoint === "function" ? value.checkpoint.bind(value) : () => null };
}

function completionFromValue(value, expectedThread) {
  if (isObject(value) && value.observation) value = value.observation;
  if (!isObject(value)) throw new ClosedLoopError("Codex observer returned no completion evidence.", CLOSED_LOOP_ERRORS.OBSERVER_INVALID);
  if (value.kind && value.kind !== "TURN_COMPLETED") throw new ClosedLoopError("Codex observer did not return a completed turn.", CLOSED_LOOP_ERRORS.TURN_NOT_COMPLETED);
  const thread = requiredText(value.thread_id || value.threadId, "completion.thread_id", CLOSED_LOOP_ERRORS.TURN_INVALID);
  if (thread !== expectedThread) throw new ClosedLoopError("Codex completion belongs to a different thread.", CLOSED_LOOP_ERRORS.WRONG_THREAD);
  const turn = requiredText(value.turn_id || value.turnId, "completion.turn_id", CLOSED_LOOP_ERRORS.TURN_INVALID);
  const status = requiredText(value.turn_status || value.status, "completion.turn_status", CLOSED_LOOP_ERRORS.TURN_INVALID);
  if (status !== "completed") throw new ClosedLoopError("Only completed turns can enter a relay round.", CLOSED_LOOP_ERRORS.TURN_NOT_COMPLETED);
  const message = boundedText(value.message ?? value.final_message ?? value.final_agent_message, "completion.message", MAX_MESSAGE_BYTES, { required: true });
  const expectedSourceHash = digestValue({ thread_id: thread, turn_id: turn, turn_status: status, message });
  const sourceHash = value.source_turn_sha256 || expectedSourceHash;
  if (!/^sha256:[0-9a-f]{64}$/i.test(sourceHash)) throw new ClosedLoopError("completion.source_turn_sha256 is invalid.", CLOSED_LOOP_ERRORS.TURN_INVALID);
  if (sourceHash !== expectedSourceHash) throw new ClosedLoopError("completion.source_turn_sha256 does not match the exact completion bytes.", CLOSED_LOOP_ERRORS.TURN_CONFLICT);
  const userPrompt = value.user_prompt === null || value.user_prompt === undefined ? null : boundedText(value.user_prompt, "completion.user_prompt", MAX_PROMPT_BYTES, { required: true });
  const submissionId = value.submission_id === null || value.submission_id === undefined ? null : boundedText(value.submission_id, "completion.submission_id", MAX_MESSAGE_BYTES, { required: true });
  const codexReturnId = value.codex_return_id === null || value.codex_return_id === undefined ? null : boundedText(value.codex_return_id, "completion.codex_return_id", MAX_MESSAGE_BYTES, { required: true });
  const rawEventHash = value.raw_event_sha256 === null || value.raw_event_sha256 === undefined ? null : value.raw_event_sha256;
  if (rawEventHash !== null && !isDigest(rawEventHash)) throw new ClosedLoopError("completion.raw_event_sha256 is invalid.", CLOSED_LOOP_ERRORS.TURN_INVALID);
  const causalProof = value.causal_proof === null || value.causal_proof === undefined ? "parent_observer" : boundedText(value.causal_proof, "completion.causal_proof", 4096, { required: true });
  return Object.freeze({ kind: "TURN_COMPLETED", thread_id: thread, turn_id: turn, turn_status: status, message, user_prompt: userPrompt, submission_id: submissionId, codex_return_id: codexReturnId, source_turn_sha256: sourceHash, raw_event_sha256: rawEventHash, causal_proof: causalProof, sequence: Number.isInteger(value.sequence) ? value.sequence : null, idempotent: value.idempotent === true });
}

export const validateCodexCompletionEvidence = completionFromValue;
export const normalizeCodexCompletion = completionFromValue;

function makeRoundReport(binding, completion, roundIndex) {
  const thread = requiredText(completion.thread_id, "completion.thread_id", CLOSED_LOOP_ERRORS.TURN_INVALID);
  const turn = requiredText(completion.turn_id, "completion.turn_id", CLOSED_LOOP_ERRORS.TURN_INVALID);
  const message = boundedText(completion.message, "completion.message", MAX_MESSAGE_BYTES, { required: true });
  const situation = `round=${roundIndex} thread_id=${thread} turn_id=${turn} status=${completion.turn_status} source_turn_sha256=${completion.source_turn_sha256}`;
  return createTaskChatRelayReport({
    binding,
    mission_id: binding.mission_id,
    completion: message,
    situation,
    status: completion.turn_status,
    source_thread_id: thread,
    source_turn_id: turn,
    source_turn_sha256: completion.source_turn_sha256,
    source_causal_proof: completion.causal_proof,
  });
}

export const createClosedLoopRoundReport = makeRoundReport;

function relayRequestId(loopId, roundIndex, completion) {
  return digestValue({ protocol: CLOSED_LOOP_PROTOCOL, loop_id: loopId, round_index: roundIndex, source_turn_id: completion.turn_id, source_turn_sha256: completion.source_turn_sha256 });
}

export const createClosedLoopRelayRequestId = relayRequestId;

function historyEntryFrom({ state, completion, requestId, reportSha, response, codexResult = null, resulting = null }) {
  return {
    round_index: state.round_index,
    source_turn_id: completion.turn_id,
    source_turn_sha256: completion.source_turn_sha256,
    report_sha256: reportSha,
    relay_request_id: requestId,
    decision: response.decision,
    codex_return_id: codexResult?.return_id ?? state.codex_return_id ?? null,
    submission_id: codexResult?.submission_id ?? null,
    resulting_turn_id: resulting?.turn_id ?? null,
    resulting_turn_sha256: resulting?.source_turn_sha256 ?? null,
  };
}

function isTerminalPhase(phase) {
  return CLOSED_LOOP_TERMINAL_PHASES.includes(phase);
}

function terminalResult(state, extra = {}) {
  return Object.freeze({ status: state.phase, loop_id: state.loop_id, mission_id: state.mission_id, task_id: state.task_id, thread_id: state.thread_id, round_index: state.round_index, terminal_reason: state.terminal_reason, history: state.history, ...extra });
}

/**
 * Parent-owned bounded multi-round controller. Every relay request is rebuilt
 * from persisted exact identities and sent through CGL003's one-round seam.
 */
export function createClosedLoopOrchestrator({
  loop_id,
  loopId,
  taskChatBinding,
  chatBinding,
  codexContinuationBinding,
  continuationBinding,
  codexRuntimeBinding,
  runtimeBinding,
  stateDir,
  loopStateDir,
  conversationStateDir,
  conversationStateDirectory,
  observer,
  codexObserver,
  observerFactory,
  localRelay,
  localModel,
  chatgptTransport,
  chatGPTTransport,
  codexSender,
  continuationSender,
  invokeCodex,
  invoke,
  runtimeProbe,
  probe,
  verifyRuntime,
  limits,
  max_rounds,
  maxRounds,
  now = () => new Date().toISOString(),
  owner_id,
  ownerId,
  initial_turn_id,
  initialTurnId,
} = {}) {
  const chat = validateTaskChatBinding(taskChatBinding || chatBinding);
  const continuation = validateCodexContinuationBinding(codexContinuationBinding || continuationBinding);
  const runtime = validateCodexRuntimeBinding(codexRuntimeBinding || runtimeBinding);
  const selectedInitialTurn = optionalText(initial_turn_id || initialTurnId || null, "initial_turn_id", CLOSED_LOOP_ERRORS.TURN_INVALID);
  if (chat.mission_id !== continuation.mission_id || chat.task_id !== continuation.task_id) throw new ClosedLoopError("Task chat and continuation identities do not match.", CLOSED_LOOP_ERRORS.IDENTITY_MISMATCH);
  if (runtime.capabilities.queue !== true) throw new ClosedLoopError("Bound runtime queue capability is required; no fallback is allowed.", CLOSED_LOOP_ERRORS.RUNTIME_INVALID);
  const selectedLimits = normalizeLimits({ ...(limits || {}), max_rounds: max_rounds ?? maxRounds ?? limits?.max_rounds ?? limits?.maxRounds ?? 8 });
  const stableId = {
    mission_id: chat.mission_id,
    task_id: chat.task_id,
    task_chat_binding_id: chat.binding_id,
    codex_continuation_binding_id: continuation.binding_id,
    codex_runtime_binding_id: runtime.binding_id,
    codex_runtime_fingerprint: runtime.runtime_fingerprint,
    thread_id: continuation.thread_id,
    limits: selectedLimits,
  };
  const id = requiredText(loop_id || loopId || digestValue(stableId), "loop_id");
  const store = createClosedLoopStateStore({ stateDir: loopStateDir || stateDir, now });
  let state = store.create({
    loop_id: id,
    mission_id: chat.mission_id,
    task_id: chat.task_id,
    task_chat_binding_id: chat.binding_id,
    conversation_id: chat.conversation_id,
    codex_continuation_binding_id: continuation.binding_id,
    codex_runtime_binding_id: runtime.binding_id,
    codex_runtime_fingerprint: runtime.runtime_fingerprint,
    thread_id: continuation.thread_id,
    limits: selectedLimits,
  });
  compareLoopImmutable({ ...state, limits: selectedLimits }, state);
  const owners = createClosedLoopOwnerLease({ stateDir: loopStateDir || stateDir, owner_id: owner_id || ownerId, now });
  const resolvedObserver = resolveObserver(observer || codexObserver, observerFactory, { continuationBinding: continuation, runtimeBinding: runtime, loop_id: id });
  let ownerHandle = null;
  let activeRun = null;
  let cancellationRequested = false;

  const verifyBoundRuntime = async () => {
    const verifier = typeof verifyRuntime === "function" ? verifyRuntime : verifyCodexRuntimeBinding;
    return verifier(runtime);
  };

  const save = (patch, options) => {
    try { state = store.update(id, patch, options); return state; }
    catch (error) {
      if (error?.code === CLOSED_LOOP_ERRORS.STATE_BUSY) state = store.load(id) || state;
      throw error;
    }
  };

  const acquireOwner = () => {
    if (ownerHandle) return { status: "ACQUIRED", handle: ownerHandle };
    const result = owners.acquire({ loop_id: id, thread_id: continuation.thread_id });
    if (result.status === "ACQUIRED") ownerHandle = result.handle;
    return result;
  };
  const releaseOwner = () => {
    if (!ownerHandle) return;
    try { owners.release(ownerHandle); } finally { ownerHandle = null; }
  };

  const admitCompletion = (value, expected = {}) => {
    const completion = completionFromValue(value, continuation.thread_id);
    if (expected.after_turn_id && completion.turn_id === expected.after_turn_id) throw new ClosedLoopError("Observed turn is the prior turn, not the queued turn.", CLOSED_LOOP_ERRORS.WRONG_TURN);
    if (expected.prompt !== undefined && expected.prompt !== null && completion.user_prompt !== null && completion.user_prompt !== expected.prompt) throw new ClosedLoopError("Observed turn prompt does not match the exact queued prompt.", CLOSED_LOOP_ERRORS.CAUSALITY_MISMATCH);
    if (expected.submission_id && completion.submission_id && expected.submission_id !== completion.submission_id) throw new ClosedLoopError("Observed turn submission does not match the queued submission.", CLOSED_LOOP_ERRORS.CAUSALITY_MISMATCH);
    if (state.last_observed_turn_id === completion.turn_id) {
      if (state.last_observed_turn_sha256 !== completion.source_turn_sha256) throw new ClosedLoopError("The same completed turn has conflicting bytes.", CLOSED_LOOP_ERRORS.TURN_CONFLICT);
      return Object.freeze({ completion, idempotent: true });
    }
    if (state.last_observed_turn_id !== null && state.phase === CLOSED_LOOP_PHASES.WAITING_FOR_CODEX_TURN && expected.after_turn_id === null) {
      throw new ClosedLoopError("A new initial turn would replace a persisted source turn.", CLOSED_LOOP_ERRORS.TURN_CONFLICT);
    }
    state = save({
      last_observed_turn_id: completion.turn_id,
      last_observed_turn_sha256: completion.source_turn_sha256,
      last_observed_turn_status: completion.turn_status,
      last_observed_message: completion.message,
      last_observed_causal_proof: completion.causal_proof,
    }, { expectedPhase: [CLOSED_LOOP_PHASES.WAITING_FOR_CODEX_TURN, CLOSED_LOOP_PHASES.WAITING_FOR_CODEX_AFTER_CONTINUE] });
    return Object.freeze({ completion, idempotent: false });
  };

  const createRelay = (report, requestId) => createFullRelayOrchestrator({
    taskChatBinding: chat,
    codexContinuationBinding: continuation,
    codexRuntimeBinding: runtime,
    report,
    relay_request_id: requestId,
    stateDir: path.join(store.stateDir, "full-relay"),
    conversationStateDir: conversationStateDir || conversationStateDirectory || path.join(store.stateDir, "full-relay-conversations"),
    localRelay: localRelay || localModel,
    chatgptTransport: chatgptTransport || chatGPTTransport,
    codexSender: codexSender || continuationSender,
    invokeCodex: invokeCodex || invoke,
    runtimeProbe: runtimeProbe || probe,
    verifyRuntime,
    now,
    chatgptTimeoutMs: selectedLimits.chatgpt_timeout_ms,
    localRelayTimeoutMs: selectedLimits.local_relay_timeout_ms,
    owner_id: `${owners.owner_id}:${id}`,
  });

  const markTerminal = (phase, reason, error = null) => {
    state = save({ phase, terminal_reason: reason, error_code: error?.code || null, error_message: error ? String(error.message || error) : null }, { expectedPhase: [state.phase] });
    return terminalResult(state, error ? { error_code: state.error_code } : {});
  };

  const runInternal = async () => {
    state = store.load(id) || state;
    compareLoopImmutable({ ...state, limits: selectedLimits }, state);
    if (isTerminalPhase(state.phase)) return terminalResult(state, { idempotent: true });
    const acquired = acquireOwner();
    if (acquired.status !== "ACQUIRED") return terminalResult(state, { status: acquired.status, owner: acquired.holder || null });
    const startedAt = Date.now();
    try {
      while (true) {
        if (cancellationRequested) return markTerminal(CLOSED_LOOP_PHASES.CANCELLED, "operator cancellation requested");
        if (selectedLimits.wall_clock_budget_ms !== null && Date.now() - startedAt >= selectedLimits.wall_clock_budget_ms) return markTerminal(CLOSED_LOOP_PHASES.MAX_ROUNDS_REACHED, "bounded wall-clock budget reached");
        if (isTerminalPhase(state.phase)) return terminalResult(state);
        try { await verifyBoundRuntime(); }
        catch (error) { return markTerminal(CLOSED_LOOP_PHASES.REJECTED, "bound Codex runtime fingerprint/capability drifted", error); }

        if (state.phase === CLOSED_LOOP_PHASES.READY || state.phase === CLOSED_LOOP_PHASES.WAITING_FOR_CODEX_TURN || state.phase === CLOSED_LOOP_PHASES.WAITING_FOR_CODEX_AFTER_CONTINUE) {
          const afterTurn = state.expected_after_turn_id;
          const prompt = state.expected_prompt;
          const submission = state.expected_submission_id;
          const afterSequence = state.expected_observer_sequence;
          const waitingPhase = afterTurn ? CLOSED_LOOP_PHASES.WAITING_FOR_CODEX_AFTER_CONTINUE : CLOSED_LOOP_PHASES.WAITING_FOR_CODEX_TURN;
          if (state.phase !== waitingPhase) state = save({ phase: waitingPhase }, { expectedPhase: [state.phase] });
          let observed;
          try {
            observed = await resolvedObserver.wait({ thread_id: continuation.thread_id, turn_id: afterTurn ? null : selectedInitialTurn, after_turn_id: afterTurn, prompt, submission_id: submission, after_sequence: afterSequence, timeout_ms: selectedLimits.turn_timeout_ms });
          } catch (error) {
            return markTerminal(CLOSED_LOOP_PHASES.DELIVERY_UNKNOWN, "exact Codex turn completion could not be proven", error);
          }
          let admitted;
          try { admitted = admitCompletion(observed, { after_turn_id: afterTurn, prompt, submission_id: submission }); }
          catch (error) { return markTerminal(CLOSED_LOOP_PHASES.REJECTED, "Codex completion identity or causal chain was rejected", error); }
          if (afterTurn && state.pending_history) {
            const pending = { ...state.pending_history, resulting_turn_id: admitted.completion.turn_id, resulting_turn_sha256: admitted.completion.source_turn_sha256 };
            const history = [...state.history, pending].slice(-MAX_HISTORY);
            const nextRoundIndex = state.round_index + 1;
            if (nextRoundIndex >= selectedLimits.max_rounds) {
              state = save({ history, pending_history: null, expected_after_turn_id: null, expected_prompt: null, expected_prompt_sha256: null, expected_submission_id: null, expected_observer_sequence: null, observer_checkpoint: null, round_index: nextRoundIndex, current_relay_request_id: null, current_report: null, current_report_sha256: null, phase: CLOSED_LOOP_PHASES.ROUND_PREPARED }, { expectedPhase: [CLOSED_LOOP_PHASES.WAITING_FOR_CODEX_AFTER_CONTINUE] });
              return markTerminal(CLOSED_LOOP_PHASES.MAX_ROUNDS_REACHED, "max_rounds reached after the exact queued turn completed");
            }
            // The resulting turn is already an admitted exact source. Build the
            // next report now; do not re-wait for it or infer a new turn by
            // arrival order after reconnect.
            const nextReport = makeRoundReport(chat, admitted.completion, nextRoundIndex);
            const nextRequestId = relayRequestId(id, nextRoundIndex, admitted.completion);
            state = save({ history, pending_history: null, expected_after_turn_id: null, expected_prompt: null, expected_prompt_sha256: null, expected_submission_id: null, expected_observer_sequence: null, observer_checkpoint: null, round_index: nextRoundIndex, current_relay_request_id: nextRequestId, current_report: nextReport, current_report_sha256: hashJson(nextReport), phase: CLOSED_LOOP_PHASES.ROUND_PREPARED }, { expectedPhase: [CLOSED_LOOP_PHASES.WAITING_FOR_CODEX_AFTER_CONTINUE] });
            continue;
          }
          const report = makeRoundReport(chat, admitted.completion, state.round_index);
          const requestId = relayRequestId(id, state.round_index, admitted.completion);
          const reportSha = hashJson(report);
          state = save({ phase: CLOSED_LOOP_PHASES.ROUND_PREPARED, current_relay_request_id: requestId, current_report: report, current_report_sha256: reportSha }, { expectedPhase: [CLOSED_LOOP_PHASES.WAITING_FOR_CODEX_TURN] });
        }

        if (state.phase === CLOSED_LOOP_PHASES.ROUND_PREPARED || state.phase === CLOSED_LOOP_PHASES.RELAY_IN_PROGRESS) {
          if (!state.current_report || !state.current_relay_request_id) return markTerminal(CLOSED_LOOP_PHASES.REJECTED, "persisted round report identity is incomplete");
          const checkpoint = state.observer_checkpoint || resolvedObserver.checkpoint();
          state = save({ phase: CLOSED_LOOP_PHASES.RELAY_IN_PROGRESS, observer_checkpoint: checkpoint, expected_observer_sequence: checkpoint?.sequence ?? null }, { expectedPhase: [CLOSED_LOOP_PHASES.ROUND_PREPARED, CLOSED_LOOP_PHASES.RELAY_IN_PROGRESS] });
          const relay = createRelay(state.current_report, state.current_relay_request_id);
          let relayResult;
          try { relayResult = await relay.run(); }
          catch (error) { return markTerminal(CLOSED_LOOP_PHASES.DELIVERY_UNKNOWN, "Full Relay raised an unproven side-effect error", error); }
          const relayState = relay.inspect();
          if ([FULL_RELAY_STATES.CHATGPT_IN_FLIGHT, FULL_RELAY_STATES.CODEX_IN_FLIGHT, FULL_RELAY_STATES.DELIVERY_UNKNOWN].includes(relayResult.status)) return markTerminal(CLOSED_LOOP_PHASES.DELIVERY_UNKNOWN, "Full Relay side effect or delivery is ambiguous", new ClosedLoopError("Full Relay returned an in-flight or unknown state.", CLOSED_LOOP_ERRORS.OBSERVER_INVALID));
          if (relayResult.status === FULL_RELAY_STATES.WAITING_FOR_CONVERSATION_SLOT) return terminalResult(state, { waiting: true, holder: relayResult.holder || null });
          if (relayResult.status === FULL_RELAY_STATES.REJECTED) return markTerminal(CLOSED_LOOP_PHASES.REJECTED, "Full Relay rejected the bounded round", new ClosedLoopError(relayState.error_message || "Full Relay rejected the round.", relayState.error_code || FULL_RELAY_ERRORS.INVALID));
          if (relayResult.status !== FULL_RELAY_STATES.COMPLETED && relayResult.status !== FULL_RELAY_STATES.STOPPED && relayResult.status !== FULL_RELAY_STATES.NEEDS_HUMAN) return markTerminal(CLOSED_LOOP_PHASES.REJECTED, "Full Relay returned an unexpected state", new ClosedLoopError(`Unexpected Full Relay status: ${relayResult.status}.`, CLOSED_LOOP_ERRORS.INVALID));
          const response = relayState.chatgpt_response;
          if (!response || response.decision === CODEX_PROMPT_DECISIONS.STOP) {
            const entry = historyEntryFrom({ state, completion: { turn_id: state.last_observed_turn_id, source_turn_sha256: state.last_observed_turn_sha256 }, requestId: state.current_relay_request_id, reportSha: state.current_report_sha256, response: response || { decision: "STOP" } });
            state = save({ history: [...state.history, entry].slice(-MAX_HISTORY) }, { expectedPhase: [CLOSED_LOOP_PHASES.RELAY_IN_PROGRESS] });
            return markTerminal(CLOSED_LOOP_PHASES.STOPPED, "ChatGPT requested STOP");
          }
          if (response.decision === CODEX_PROMPT_DECISIONS.NEEDS_HUMAN) {
            const entry = historyEntryFrom({ state, completion: { turn_id: state.last_observed_turn_id, source_turn_sha256: state.last_observed_turn_sha256 }, requestId: state.current_relay_request_id, reportSha: state.current_report_sha256, response });
            state = save({ history: [...state.history, entry].slice(-MAX_HISTORY) }, { expectedPhase: [CLOSED_LOOP_PHASES.RELAY_IN_PROGRESS] });
            return markTerminal(CLOSED_LOOP_PHASES.NEEDS_HUMAN, "ChatGPT requested human attention");
          }
          if (response.decision !== CODEX_PROMPT_DECISIONS.CONTINUE || typeof response.prompt !== "string") return markTerminal(CLOSED_LOOP_PHASES.REJECTED, "ChatGPT response decision is not admissible");
          const codexResult = relayState.codex_result || {};
          if (codexResult.mode !== "queue") return markTerminal(CLOSED_LOOP_PHASES.REJECTED, "Full Relay did not use the bound queue continuation", new ClosedLoopError("Only the native queue continuation is admissible.", CLOSED_LOOP_ERRORS.RUNTIME_INVALID));
          if (codexResult.thread_id !== continuation.thread_id) return markTerminal(CLOSED_LOOP_PHASES.REJECTED, "Full Relay queue result did not prove the exact thread", new ClosedLoopError("Queue result thread mismatch.", CLOSED_LOOP_ERRORS.WRONG_THREAD));
          const pending = historyEntryFrom({ state, completion: { turn_id: state.last_observed_turn_id, source_turn_sha256: state.last_observed_turn_sha256 }, requestId: state.current_relay_request_id, reportSha: state.current_report_sha256, response, codexResult });
          const persistedCheckpoint = state.observer_checkpoint;
          state = save({
            phase: CLOSED_LOOP_PHASES.WAITING_FOR_CODEX_AFTER_CONTINUE,
            expected_after_turn_id: state.last_observed_turn_id,
            expected_prompt: response.prompt,
            expected_prompt_sha256: sha256(response.prompt),
            expected_submission_id: codexResult.submission_id || null,
            expected_observer_sequence: persistedCheckpoint?.sequence ?? null,
            pending_history: pending,
          }, { expectedPhase: [CLOSED_LOOP_PHASES.RELAY_IN_PROGRESS] });
          continue;
        }
        return markTerminal(CLOSED_LOOP_PHASES.REJECTED, `unexpected closed-loop phase: ${state.phase}`);
      }
    } finally {
      releaseOwner();
    }
  };

  const run = async () => {
    if (activeRun) return activeRun;
    activeRun = runInternal();
    try { return await activeRun; } finally { activeRun = null; }
  };
  const cancel = () => { cancellationRequested = true; return Object.freeze({ status: "CANCEL_REQUESTED", loop_id: id }); };
  const inspect = () => cloneFrozen(state);
  const close = () => { try { resolvedObserver.value.close?.(); } finally { releaseOwner(); } };
  return Object.freeze({ loop_id: id, bindings: cloneFrozen({ chat, continuation, runtime }), stateStore: store, ownerLease: owners, observer: resolvedObserver.value, run, execute: run, start: run, cancel, close, inspect });
}

export const createBoundedClosedLoop = createClosedLoopOrchestrator;
export const createDevExecClosedLoop = createClosedLoopOrchestrator;

export async function runClosedLoop(options = {}) {
  const orchestrator = createClosedLoopOrchestrator(options);
  try { return await orchestrator.run(); } finally { orchestrator.close(); }
}

export const runBoundedClosedLoop = runClosedLoop;

export class ClosedLoopError extends Error {
  constructor(message, code = CLOSED_LOOP_ERRORS.INVALID, cause = undefined) {
    super(message);
    this.name = "ClosedLoopError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}
