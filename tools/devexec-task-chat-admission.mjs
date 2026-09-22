import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import {
  createTaskChatBinding,
  validateTaskChatBinding,
} from "./devexec-task-chat-binding.mjs";

export const TASK_CHAT_ADMISSION_PROTOCOL = "devexec.task-chat-admission";
export const TASK_CHAT_ADMISSION_SCHEMA_VERSION = 1;
export const TASK_CHAT_ADMISSION_PHASES = Object.freeze({
  ABSENT: "ABSENT",
  RESERVED: "RESERVED",
  SEND_INTENT: "SEND_INTENT",
  ACKED: "ACKED",
  BOUND: "BOUND",
  FAILED_PRE_SEND: "FAILED_PRE_SEND",
  ADMISSION_UNKNOWN: "ADMISSION_UNKNOWN",
  CONFLICT: "CONFLICT",
});

export const TASK_CHAT_ADMISSION_ERRORS = Object.freeze({
  REQUIRED: "TASK_CHAT_ADMISSION_REQUIRED",
  INVALID: "TASK_CHAT_ADMISSION_INVALID",
  CONFLICT: "TASK_CHAT_ADMISSION_CONFLICT",
  UNKNOWN: "ADMISSION_UNKNOWN",
  FAILED_PRE_SEND: "FAILED_PRE_SEND",
  BUSY: "TASK_CHAT_ADMISSION_BUSY",
});

const STATE_FIELDS = Object.freeze([
  "protocol",
  "schema_version",
  "admission_id",
  "mission_id",
  "task_id",
  "phase",
  "seed_hash",
  "created_at",
  "updated_at",
  "acknowledgement",
  "binding",
  "failure",
]);
const ACK_FIELDS = Object.freeze([
  "status",
  "chat_url",
  "conversation_id",
  "user_turn_seq",
  "user_turn_index",
  "ack_turn_count",
  "user_turn_text",
  "acked_at",
]);
const FAILURE_FIELDS = Object.freeze(["code", "message", "at"]);
const ADMISSION_ID_RE = /^admit-[a-f0-9]{64}$/;
const DEFAULT_ROOT = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "ChatGPTMCPProbe",
  "task-chat-admissions-v1",
);
const MAX_STATE_BYTES = 512 * 1024;
const LOCK_WAIT_MS = 30_000;
const LOCK_RETRY_MS = 50;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requiredText(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw admissionError(`${label} must be an exact non-empty string.`, TASK_CHAT_ADMISSION_ERRORS.REQUIRED);
  }
  return value;
}

function admissionError(message, code = TASK_CHAT_ADMISSION_ERRORS.INVALID, cause = undefined) {
  const error = new Error(message);
  error.name = "TaskChatAdmissionError";
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonical(value[key]);
    return result;
  }
  return value;
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value), "utf8").digest("hex")}`;
}

function nowIso(now) {
  const value = typeof now === "function" ? now() : new Date().toISOString();
  return requiredText(value, "timestamp");
}

function identityOf(missionId, taskId) {
  return { protocol: TASK_CHAT_ADMISSION_PROTOCOL, schema_version: TASK_CHAT_ADMISSION_SCHEMA_VERSION, mission_id: missionId, task_id: taskId };
}

export function computeTaskChatAdmissionId(missionId, taskId) {
  const mission = requiredText(missionId, "mission_id");
  const task = requiredText(taskId, "task_id");
  return `admit-${crypto.createHash("sha256").update(JSON.stringify(identityOf(mission, task)), "utf8").digest("hex")}`;
}

export function buildTaskChatAdmissionSeed({ mission_id, task_id, admission_id } = {}) {
  const missionId = requiredText(mission_id, "mission_id");
  const taskId = requiredText(task_id, "task_id");
  const admissionId = requiredText(admission_id || computeTaskChatAdmissionId(missionId, taskId), "admission_id");
  return `[TASK_CHAT_ADMISSION][${admissionId}]\nMISSION: ${missionId}\nTASK: ${taskId}\nROLE: Bound ChatGPT advisory/report channel for this durable Task lineage.\nNOTE: Execution authority remains with the local system. Later REPORT/CONSULT messages will use this exact conversation.`;
}

export function taskChatAdmissionSeedHash(seed) {
  return sha256(requiredText(seed, "seed"));
}

function rootPath(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_ROOT;
  const text = requiredText(value, "admission_root");
  if (!path.isAbsolute(text) && !path.win32.isAbsolute(text) && !path.posix.isAbsolute(text)) {
    throw admissionError("admission_root must be an absolute path.", TASK_CHAT_ADMISSION_ERRORS.INVALID);
  }
  return path.normalize(text);
}

export const DEFAULT_TASK_CHAT_ADMISSION_ROOT = DEFAULT_ROOT;

export function taskChatAdmissionPath(missionId, taskId, { admissionRoot = DEFAULT_ROOT } = {}) {
  const id = computeTaskChatAdmissionId(missionId, taskId);
  return path.join(rootPath(admissionRoot), "admissions-v1", `${id}.json`);
}

function lockPath(filePath) {
  return `${filePath}.lock`;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function removeDeadLock(lock) {
  let owner;
  try { owner = Number.parseInt(fs.readFileSync(lock, "utf8").trim(), 10); }
  catch { return false; }
  if (!Number.isInteger(owner) || owner <= 0) return false;
  try {
    process.kill(owner, 0);
    return false;
  } catch (error) {
    if (error?.code !== "ESRCH") return false;
    try { fs.unlinkSync(lock); return true; } catch { return false; }
  }
}

async function acquireLock(filePath, waitMs = LOCK_WAIT_MS) {
  const lock = lockPath(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const deadline = Date.now() + Math.max(1, Number(waitMs) || LOCK_WAIT_MS);
  let absentEpermRetryUsed = false;
  for (;;) {
    try {
      const handle = await fs.promises.open(lock, "wx");
      await handle.writeFile(`${process.pid}\n`, "utf8");
      return { handle, lock };
    } catch (error) {
      // Windows may report a second exclusive open as EPERM rather than
      // EEXIST. A releasing owner can also remove the lock between that
      // failed open and our path check. Allow exactly one bounded retry for
      // that absent-path race; repeated invisible EPERM remains a hard error
      // instead of being mislabeled as another writer indefinitely.
      if (error?.code === "EPERM" && !fs.existsSync(lock)) {
        if (absentEpermRetryUsed) throw error;
        absentEpermRetryUsed = true;
        if (Date.now() >= deadline) throw error;
        await sleep(LOCK_RETRY_MS);
        continue;
      }
      if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
      absentEpermRetryUsed = false;
      // A host crash can leave the lock marker behind. Reclaim only when its
      // recorded owner PID is provably gone; malformed/permission-denied
      // markers remain fail-closed and are never blindly removed.
      removeDeadLock(lock);
      if (Date.now() >= deadline) throw admissionError("Another admission writer owns this Task admission.", TASK_CHAT_ADMISSION_ERRORS.BUSY);
      await sleep(LOCK_RETRY_MS);
    }
  }
}

async function releaseLock(held) {
  if (!held) return;
  try { await held.handle.close(); } catch {}
  try { await fs.promises.unlink(held.lock); } catch {}
}

function atomicWrite(filePath, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(payload, "utf8") > MAX_STATE_BYTES) throw admissionError("Task chat admission state exceeds the bounded size.");
  const temp = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, payload, { encoding: "utf8", flag: "wx" });
  try {
    // Windows rejects fsync on a read-only handle (EPERM); r+ preserves the
    // same flush guarantee on both Windows and POSIX hosts.
    const fd = fs.openSync(temp, "r+");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, filePath);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

function readRaw(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > MAX_STATE_BYTES) throw admissionError("Task chat admission state is unavailable or too large.");
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch (error) { throw admissionError("Task chat admission state is not valid JSON.", TASK_CHAT_ADMISSION_ERRORS.INVALID, error); }
  return parsed;
}

function exactKeys(value, allowed, label) {
  if (!isObject(value)) throw admissionError(`${label} must be an object.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw admissionError(`${label} contains unknown field: ${key}.`);
}

function normalizeAcknowledgement(value) {
  if (!isObject(value)) throw admissionError("acknowledgement must be an object.");
  exactKeys(value, ACK_FIELDS, "acknowledgement");
  for (const key of ACK_FIELDS) if (!hasOwn(value, key)) throw admissionError(`acknowledgement field is missing: ${key}.`);
  if (value.status !== "USER_TURN_ACK") throw admissionError("acknowledgement.status must be USER_TURN_ACK.");
  requiredText(value.chat_url, "acknowledgement.chat_url");
  requiredText(value.conversation_id, "acknowledgement.conversation_id");
  if (!Number.isInteger(value.user_turn_seq) || value.user_turn_seq < 0) throw admissionError("acknowledgement.user_turn_seq must be a non-negative integer.");
  if (!Number.isInteger(value.user_turn_index) || value.user_turn_index < 0) throw admissionError("acknowledgement.user_turn_index must be a non-negative integer.");
  if (!Number.isInteger(value.ack_turn_count) || value.ack_turn_count < 1) throw admissionError("acknowledgement.ack_turn_count must be a positive integer.");
  if (value.user_turn_text !== null) requiredText(value.user_turn_text, "acknowledgement.user_turn_text");
  requiredText(value.acked_at, "acknowledgement.acked_at");
  return { ...value };
}

function normalizeFailure(value) {
  if (value === null) return null;
  if (!isObject(value)) throw admissionError("failure must be an object or null.");
  exactKeys(value, FAILURE_FIELDS, "failure");
  for (const key of FAILURE_FIELDS) requiredText(value[key], `failure.${key}`);
  return { ...value };
}

function validateState(value) {
  if (!isObject(value)) throw admissionError("Task chat admission state must be an object.");
  exactKeys(value, STATE_FIELDS, "Task chat admission state");
  for (const key of STATE_FIELDS) if (!hasOwn(value, key)) throw admissionError(`Task chat admission state field is missing: ${key}.`);
  if (value.protocol !== TASK_CHAT_ADMISSION_PROTOCOL || value.schema_version !== TASK_CHAT_ADMISSION_SCHEMA_VERSION) throw admissionError("Unsupported task chat admission protocol or schema_version.");
  if (!ADMISSION_ID_RE.test(value.admission_id)) throw admissionError("admission_id is invalid.");
  requiredText(value.mission_id, "mission_id");
  requiredText(value.task_id, "task_id");
  const expectedId = computeTaskChatAdmissionId(value.mission_id, value.task_id);
  if (value.admission_id !== expectedId) throw admissionError("admission_id does not match mission_id + task_id.", TASK_CHAT_ADMISSION_ERRORS.CONFLICT);
  if (!Object.values(TASK_CHAT_ADMISSION_PHASES).includes(value.phase)) throw admissionError("Task chat admission phase is invalid.");
  requiredText(value.seed_hash, "seed_hash");
  requiredText(value.created_at, "created_at");
  requiredText(value.updated_at, "updated_at");
  const ack = value.acknowledgement === null ? null : normalizeAcknowledgement(value.acknowledgement);
  const binding = value.binding === null ? null : validateTaskChatBinding(value.binding);
  const failure = normalizeFailure(value.failure);
  if (value.phase === TASK_CHAT_ADMISSION_PHASES.BOUND && (!ack || !binding || failure !== null)) throw admissionError("BOUND admission must contain acknowledgement and binding only.");
  if (value.phase === TASK_CHAT_ADMISSION_PHASES.ACKED && (!ack || binding !== null)) throw admissionError("ACKED admission must contain acknowledgement and no binding.");
  if (value.phase === TASK_CHAT_ADMISSION_PHASES.ADMISSION_UNKNOWN && failure?.code !== TASK_CHAT_ADMISSION_ERRORS.UNKNOWN) throw admissionError("ADMISSION_UNKNOWN must classify failure as ADMISSION_UNKNOWN.");
  if (value.phase === TASK_CHAT_ADMISSION_PHASES.FAILED_PRE_SEND && failure?.code !== TASK_CHAT_ADMISSION_ERRORS.FAILED_PRE_SEND) throw admissionError("FAILED_PRE_SEND must classify failure as FAILED_PRE_SEND.");
  return Object.freeze({ ...value, acknowledgement: ack, binding, failure });
}

function stateFor({ mission_id, task_id, phase, seed_hash, created_at, updated_at, acknowledgement = null, binding = null, failure = null }) {
  return validateState({
    protocol: TASK_CHAT_ADMISSION_PROTOCOL,
    schema_version: TASK_CHAT_ADMISSION_SCHEMA_VERSION,
    admission_id: computeTaskChatAdmissionId(mission_id, task_id),
    mission_id,
    task_id,
    phase,
    seed_hash,
    created_at,
    updated_at,
    acknowledgement,
    binding,
    failure,
  });
}

function transitionError(error, fallbackCode) {
  const message = error instanceof Error ? error.message : String(error);
  return { code: fallbackCode, message: message.slice(0, 2_000), at: new Date().toISOString() };
}

function statusFromState(state, file) {
  if (!state) return Object.freeze({
    protocol: TASK_CHAT_ADMISSION_PROTOCOL,
    schema_version: TASK_CHAT_ADMISSION_SCHEMA_VERSION,
    admission_id: null,
    mission_id: null,
    task_id: null,
    phase: TASK_CHAT_ADMISSION_PHASES.ABSENT,
    binding: null,
    acknowledgement: null,
    failure: null,
    file,
  });
  return Object.freeze({
    protocol: state.protocol,
    schema_version: state.schema_version,
    admission_id: state.admission_id,
    mission_id: state.mission_id,
    task_id: state.task_id,
    phase: state.phase,
    binding: state.binding,
    acknowledgement: state.acknowledgement,
    failure: state.failure,
    file,
  });
}

function assertInput(input) {
  if (!isObject(input)) throw admissionError("Task chat admission input is required.", TASK_CHAT_ADMISSION_ERRORS.REQUIRED);
  return { mission_id: requiredText(input.mission_id || input.missionId, "mission_id"), task_id: requiredText(input.task_id || input.taskId, "task_id") };
}

/** Read-only status. This never consults browser state, aliases, or defaults. */
export function taskChatAdmissionStatus(input = {}) {
  const { mission_id, task_id } = assertInput(input);
  const file = taskChatAdmissionPath(mission_id, task_id, { admissionRoot: input.admission_root || input.admissionRoot });
  const raw = readRaw(file);
  const state = raw === null ? null : validateState(raw);
  if (state && (state.mission_id !== mission_id || state.task_id !== task_id)) throw admissionError("Persisted admission identity conflicts with the requested Task.", TASK_CHAT_ADMISSION_ERRORS.CONFLICT);
  return statusFromState(state, file);
}

async function prepareForSeed({ prepare, seed, admission_id, mission_id, task_id }) {
  if (typeof prepare !== "function") throw admissionError("A pre-send admission preparation function is required.", TASK_CHAT_ADMISSION_ERRORS.FAILED_PRE_SEND);
  return prepare({ seed, admission_id, mission_id, task_id });
}

function normalizeAck(result, { seed, now }) {
  if (!isObject(result)) throw admissionError("Automatic ChatGPT provisioning returned no acknowledgement.", TASK_CHAT_ADMISSION_ERRORS.UNKNOWN);
  const chatUrl = result.chat_url || result.chatUrl;
  const conversationId = result.conversation_id || result.conversationId;
  const ack = result.acknowledgement || result.ack;
  if (!isObject(ack) || ack.status !== "USER_TURN_ACK") throw admissionError("Automatic ChatGPT provisioning did not return USER_TURN_ACK.", TASK_CHAT_ADMISSION_ERRORS.UNKNOWN);
  const bindingProbe = createTaskChatBinding({ mission_id: "probe-mission", task_id: "probe-task", chat_url: chatUrl, conversation_id: conversationId, source: "auto-task-admission", source_alias: "probe", bound_at: nowIso(now) });
  if (bindingProbe.conversation_id !== conversationId) throw admissionError("Provisioned conversation id does not match canonical URL.", TASK_CHAT_ADMISSION_ERRORS.UNKNOWN);
  const normalized = {
    status: "USER_TURN_ACK",
    chat_url: bindingProbe.chat_url,
    conversation_id: bindingProbe.conversation_id,
    user_turn_seq: ack.user_turn_seq ?? ack.userTurnSeq,
    user_turn_index: ack.user_turn_index ?? ack.userTurnIndex,
    ack_turn_count: ack.ack_turn_count ?? ack.ackTurnCount,
    user_turn_text: ack.user_turn_text ?? ack.userTurnText ?? null,
    acked_at: ack.acked_at || ack.ackedAt || nowIso(now),
  };
  return normalizeAcknowledgement(normalized);
}

/**
 * Admit one durable Task to exactly one fresh ChatGPT conversation. The
 * `prepare` callback must complete all local/browser preparation without
 * creating or sending a conversation; `send` is the first external side
 * effect and is called only after SEND_INTENT has been persisted.
 */
export async function admitTaskChat(input = {}) {
  const { mission_id, task_id } = assertInput(input);
  const root = rootPath(input.admission_root || input.admissionRoot);
  const file = taskChatAdmissionPath(mission_id, task_id, { admissionRoot: root });
  const admission_id = computeTaskChatAdmissionId(mission_id, task_id);
  const seed = buildTaskChatAdmissionSeed({ mission_id, task_id, admission_id });
  const seed_hash = taskChatAdmissionSeedHash(seed);
  const held = await acquireLock(file, input.lock_wait_ms);
  try {
    let state = readRaw(file);
    if (state !== null) {
      state = validateState(state);
      if (state.mission_id !== mission_id || state.task_id !== task_id || state.seed_hash !== seed_hash) {
        throw admissionError("Existing Task admission has incompatible immutable parameters.", TASK_CHAT_ADMISSION_ERRORS.CONFLICT);
      }
      if (state.phase === TASK_CHAT_ADMISSION_PHASES.BOUND) return Object.freeze({ created: false, replay: true, seed_sent: false, state: statusFromState(state, file), binding: state.binding, admission_id, file });
      if (state.phase === TASK_CHAT_ADMISSION_PHASES.ADMISSION_UNKNOWN) throw admissionError("Automatic ChatGPT admission is ambiguous; inspect status before any recovery.", TASK_CHAT_ADMISSION_ERRORS.UNKNOWN);
      if (state.phase === TASK_CHAT_ADMISSION_PHASES.SEND_INTENT) throw admissionError("Automatic ChatGPT admission has an unverified send intent; no blind retry is permitted.", TASK_CHAT_ADMISSION_ERRORS.UNKNOWN);
      if (state.phase === TASK_CHAT_ADMISSION_PHASES.ACKED) {
        const binding = createTaskChatBinding({ mission_id, task_id, chat_url: state.acknowledgement.chat_url, conversation_id: state.acknowledgement.conversation_id, source: "auto-task-admission", source_alias: admission_id, bound_at: state.acknowledgement.acked_at });
        state = stateFor({ mission_id, task_id, phase: TASK_CHAT_ADMISSION_PHASES.BOUND, seed_hash, created_at: state.created_at, updated_at: nowIso(input.now), acknowledgement: state.acknowledgement, binding });
        atomicWrite(file, state);
        return Object.freeze({ created: false, replay: true, seed_sent: false, state: statusFromState(state, file), binding, admission_id, file });
      }
      if (state.phase !== TASK_CHAT_ADMISSION_PHASES.RESERVED && state.phase !== TASK_CHAT_ADMISSION_PHASES.FAILED_PRE_SEND) {
        throw admissionError(`Task admission cannot continue from phase ${state.phase}.`, TASK_CHAT_ADMISSION_ERRORS.INVALID);
      }
    } else {
      const timestamp = nowIso(input.now);
      state = stateFor({ mission_id, task_id, phase: TASK_CHAT_ADMISSION_PHASES.RESERVED, seed_hash, created_at: timestamp, updated_at: timestamp });
      atomicWrite(file, state);
    }

    try {
      const prepared = await prepareForSeed({ prepare: input.prepare, seed, admission_id, mission_id, task_id });
      state = stateFor({ mission_id, task_id, phase: TASK_CHAT_ADMISSION_PHASES.SEND_INTENT, seed_hash, created_at: state.created_at, updated_at: nowIso(input.now) });
      atomicWrite(file, state);
      if (typeof input.send !== "function") throw admissionError("A send function is required after SEND_INTENT.", TASK_CHAT_ADMISSION_ERRORS.UNKNOWN);
      const result = await input.send({ prepared, seed, admission_id, mission_id, task_id });
      const acknowledgement = normalizeAck(result, { seed, now: input.now });
      state = stateFor({ mission_id, task_id, phase: TASK_CHAT_ADMISSION_PHASES.ACKED, seed_hash, created_at: state.created_at, updated_at: nowIso(input.now), acknowledgement });
      atomicWrite(file, state);
      const binding = createTaskChatBinding({ mission_id, task_id, chat_url: acknowledgement.chat_url, conversation_id: acknowledgement.conversation_id, source: "auto-task-admission", source_alias: admission_id, bound_at: acknowledgement.acked_at });
      state = stateFor({ mission_id, task_id, phase: TASK_CHAT_ADMISSION_PHASES.BOUND, seed_hash, created_at: state.created_at, updated_at: nowIso(input.now), acknowledgement, binding });
      atomicWrite(file, state);
      return Object.freeze({ created: true, replay: false, seed_sent: true, state: statusFromState(state, file), binding, admission_id, file });
    } catch (error) {
      // Only a persisted SEND_INTENT proves that the first external send
      // operation was reached. Preparation failures remain retryable even if
      // an adapter happened to reuse the UNKNOWN error code.
      const unknown = state.phase === TASK_CHAT_ADMISSION_PHASES.SEND_INTENT;
      const phase = unknown ? TASK_CHAT_ADMISSION_PHASES.ADMISSION_UNKNOWN : TASK_CHAT_ADMISSION_PHASES.FAILED_PRE_SEND;
      const code = unknown ? TASK_CHAT_ADMISSION_ERRORS.UNKNOWN : TASK_CHAT_ADMISSION_ERRORS.FAILED_PRE_SEND;
      const failure = transitionError(error, code);
      state = stateFor({ mission_id, task_id, phase, seed_hash, created_at: state.created_at, updated_at: nowIso(input.now), failure });
      atomicWrite(file, state);
      throw admissionError(failure.message, code, error);
    }
  } finally {
    await releaseLock(held);
  }
}

export const taskChatAdmit = admitTaskChat;
export const getTaskChatAdmissionStatus = taskChatAdmissionStatus;
