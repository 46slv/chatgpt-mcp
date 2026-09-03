import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const OPERATOR_EVENT_PROTOCOL = "devexec.operator-event";
export const OPERATOR_EVENT_SCHEMA_VERSION = 1;
export const EVENT_RECORD_PROTOCOL = "devexec.operator-event-record";
export const EVENT_RECORD_SCHEMA_VERSION = 1;
export const EVENT_RECEIPT_PROTOCOL = "devexec.event-receipt";
export const EVENT_RECEIPT_SCHEMA_VERSION = 1;
export const MISSION_SNAPSHOT_PROTOCOL = "devexec.mission-snapshot";
export const MISSION_SNAPSHOT_SCHEMA_VERSION = 1;
export const MISSION_RESULT_PROTOCOL = "devexec.mission-result";
export const MISSION_RESULT_SCHEMA_VERSION = 1;
export const IDEMPOTENCY_RECORD_PROTOCOL = "devexec.idempotency-record";
export const IDEMPOTENCY_RECORD_SCHEMA_VERSION = 1;

export const EVENT_STATUSES = Object.freeze([
  "RECEIVED", "ACCEPTED", "DEFERRED", "APPLIED", "DUPLICATE", "REJECTED", "BLOCKED",
]);

const EVENT_STATUS_SET = new Set(EVENT_STATUSES);
const EVENT_KINDS = new Set(["operator.request.submitted", "operator.followup.submitted"]);
const INTENTS = new Set(["TASK", "CONSULTATION"]);
const AUTHORITIES = Object.freeze({ READ_ONLY: 0, BOUNDED_WRITE: 1 });
const RESULT_STATUSES = new Set(["COMPLETE", "BLOCKED", "NEEDS_HUMAN", "CANCELLED", "FAILED"]);
const LOGICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ADAPTER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const SHA256_REF = /^sha256:[a-f0-9]{64}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const JOURNAL_FILE = /^(\d{8})\.json$/;
const IDEMPOTENCY_FILE = /^([a-f0-9]{64})\.json$/;
const MAX_JOURNAL_RECORDS = 16384;
const MAX_RECORD_BYTES = 128 * 1024;
const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;

const INPUT_EVENT_KEYS = Object.freeze([
  "protocol", "schema_version", "event_id", "request_id", "idempotency_key", "kind",
  "occurred_at", "source", "subject", "intent", "requested_authority", "payload_ref", "correlation_id",
]);
const SOURCE_KEYS = Object.freeze(["type", "adapter", "binding_id"]);
const SUBJECT_KEYS = Object.freeze(["mission_id"]);
const PAYLOAD_REF_KEYS = Object.freeze(["sha256", "location"]);
const JOURNAL_EVENT_KEYS = Object.freeze([
  "occurred_at", "source_binding_id", "source_adapter", "subject_mission_id", "intent",
  "requested_authority", "payload_ref", "correlation_id",
]);
const EVENT_RECORD_KEYS = Object.freeze([
  "protocol", "schema_version", "journal_seq", "event_id", "request_id", "mission_id",
  "idempotency_digest", "kind", "event", "status", "reason_code", "committed_at",
  "previous_record_hash", "record_hash",
]);
const RECEIPT_KEYS = Object.freeze([
  "protocol", "schema_version", "event_id", "request_id", "mission_id", "status",
  "canonical_status", "reason_code", "idempotency_digest", "journal_seq",
]);
const FOLLOWUP_KEYS = Object.freeze([
  "event_id", "request_id", "payload_ref", "correlation_id", "requested_authority",
  "applied_at", "applied_journal_seq",
]);
const SNAPSHOT_KEYS = Object.freeze([
  "protocol", "schema_version", "mission_id", "initial_request_id", "initial_event_id", "intent",
  "authority_ceiling", "status", "created_at", "last_journal_seq", "applied_event_ids",
  "deferred_event_ids", "followups", "result_id", "result_status", "completed_at", "snapshot_hash",
]);
const COMPLETION_INPUT_KEYS = Object.freeze([
  "status", "summary", "changed_surface", "evidence_refs", "remaining_limits", "episode_aggregate",
]);
const EPISODE_AGGREGATE_KEYS = Object.freeze(["episode_count", "runtime_classes", "escalation_count"]);
const RESULT_KEYS = Object.freeze([
  "protocol", "schema_version", "request_id", "mission_id", "result_id", "status", "summary",
  "changed_surface", "evidence_refs", "remaining_limits", "episode_aggregate", "completed_at", "result_hash",
]);
const IDEMPOTENCY_KEYS = Object.freeze([
  "protocol", "schema_version", "idempotency_digest", "event_digest", "state", "event_id",
  "request_id", "mission_id", "status", "reason_code", "journal_seq", "created_at", "updated_at", "record_hash",
]);

const ALLOWED_TRANSITIONS = Object.freeze({
  RECEIVED: new Set(["ACCEPTED", "REJECTED", "BLOCKED"]),
  ACCEPTED: new Set(["DEFERRED", "APPLIED"]),
  DEFERRED: new Set(["APPLIED", "BLOCKED"]),
  APPLIED: new Set(),
  REJECTED: new Set(),
  BLOCKED: new Set(),
});

export class MissionCoreError extends Error {
  constructor(code, message, { status = "BLOCKED" } = {}) {
    super(message);
    this.name = "MissionCoreError";
    this.code = code;
    this.status = status;
  }
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isObject(value)) throw new MissionCoreError("INVALID_EVENT_ENVELOPE", `${label} must be an object`, { status: "REJECTED" });
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || wanted.some((key, index) => key !== actual[index])) {
    throw new MissionCoreError("INVALID_EVENT_ENVELOPE", `${label} has unknown or missing keys`, { status: "REJECTED" });
  }
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : canonical(value), "utf8").digest("hex");
}

function withoutHash(value, key) {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function validateLogicalId(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (typeof value !== "string" || !LOGICAL_ID.test(value) || value.includes("..") || value.includes("/") || value.includes("\\")) {
    throw new MissionCoreError("INVALID_EVENT_IDENTITY", `${label} is invalid`, { status: "REJECTED" });
  }
  return value;
}

function validateTimestamp(value, label = "timestamp") {
  if (typeof value !== "string" || value.length < 20 || value.length > 40 || !Number.isFinite(Date.parse(value))) {
    throw new MissionCoreError("INVALID_EVENT_TIMESTAMP", `${label} is invalid`, { status: "REJECTED" });
  }
  return value;
}

function validateBoundedString(value, label, max, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) {
    throw new MissionCoreError("INVALID_EVENT_ENVELOPE", `${label} is invalid`, { status: "REJECTED" });
  }
  return value;
}

function validateStringArray(value, label, { maxItems = 128, maxChars = 512 } = {}) {
  if (!Array.isArray(value) || value.length > maxItems) throw new MissionCoreError("INVALID_MISSION_RESULT", `${label} is invalid`);
  for (const item of value) validateBoundedString(item, label, maxChars, { allowEmpty: false });
  return value;
}

function validatePayloadRef(value) {
  exactKeys(value, PAYLOAD_REF_KEYS, "payload_ref");
  if (typeof value.sha256 !== "string" || !SHA256_REF.test(value.sha256)) {
    throw new MissionCoreError("INVALID_PAYLOAD_REF", "payload_ref.sha256 must be sha256:<64 hex>", { status: "REJECTED" });
  }
  validateBoundedString(value.location, "payload_ref.location", 512);
  return { sha256: value.sha256, location: value.location };
}

export function validateOperatorEvent(input) {
  exactKeys(input, INPUT_EVENT_KEYS, "operator event");
  if (input.protocol !== OPERATOR_EVENT_PROTOCOL) {
    throw new MissionCoreError("UNSUPPORTED_EVENT_PROTOCOL", "unsupported operator event protocol", { status: "REJECTED" });
  }
  if (input.schema_version !== OPERATOR_EVENT_SCHEMA_VERSION) {
    throw new MissionCoreError("UNSUPPORTED_SCHEMA_VERSION", "unsupported operator event schema version", { status: "REJECTED" });
  }
  validateLogicalId(input.event_id, "event_id");
  validateLogicalId(input.request_id, "request_id");
  validateBoundedString(input.idempotency_key, "idempotency_key", 256);
  if (!EVENT_KINDS.has(input.kind)) throw new MissionCoreError("UNSUPPORTED_EVENT_KIND", "unsupported operator event kind", { status: "REJECTED" });
  validateTimestamp(input.occurred_at, "occurred_at");
  exactKeys(input.source, SOURCE_KEYS, "source");
  if (input.source.type !== "operator") throw new MissionCoreError("UNSUPPORTED_EVENT_SOURCE", "unsupported operator event source", { status: "REJECTED" });
  if (typeof input.source.adapter !== "string" || !ADAPTER_ID.test(input.source.adapter)) {
    throw new MissionCoreError("INVALID_EVENT_SOURCE", "source.adapter is invalid", { status: "REJECTED" });
  }
  if (typeof input.source.binding_id !== "string" || !SHA256_REF.test(input.source.binding_id)) {
    throw new MissionCoreError("INVALID_EVENT_SOURCE", "source.binding_id must be sha256:<64 hex>", { status: "REJECTED" });
  }
  exactKeys(input.subject, SUBJECT_KEYS, "subject");
  validateLogicalId(input.subject.mission_id, "mission_id", { nullable: true });
  if (!INTENTS.has(input.intent)) throw new MissionCoreError("UNSUPPORTED_INTENT", "unsupported operator intent", { status: "REJECTED" });
  if (!(input.requested_authority in AUTHORITIES)) {
    throw new MissionCoreError("UNSUPPORTED_AUTHORITY_CLASS", "unsupported requested authority", { status: "REJECTED" });
  }
  const payloadRef = validatePayloadRef(input.payload_ref);
  validateLogicalId(input.correlation_id, "correlation_id");
  return {
    protocol: input.protocol,
    schema_version: input.schema_version,
    event_id: input.event_id,
    request_id: input.request_id,
    idempotency_key: input.idempotency_key,
    kind: input.kind,
    occurred_at: input.occurred_at,
    source: { type: input.source.type, adapter: input.source.adapter, binding_id: input.source.binding_id },
    subject: { mission_id: input.subject.mission_id },
    intent: input.intent,
    requested_authority: input.requested_authority,
    payload_ref: payloadRef,
    correlation_id: input.correlation_id,
  };
}

function projectEvent(event) {
  return {
    occurred_at: event.occurred_at,
    source_binding_id: event.source.binding_id,
    source_adapter: event.source.adapter,
    subject_mission_id: event.subject.mission_id,
    intent: event.intent,
    requested_authority: event.requested_authority,
    payload_ref: { ...event.payload_ref },
    correlation_id: event.correlation_id,
  };
}

function validateJournalEvent(value) {
  exactKeys(value, JOURNAL_EVENT_KEYS, "journal event");
  validateTimestamp(value.occurred_at, "journal event occurred_at");
  if (typeof value.source_binding_id !== "string" || !SHA256_REF.test(value.source_binding_id)) throw new Error("journal event source binding invalid");
  if (typeof value.source_adapter !== "string" || !ADAPTER_ID.test(value.source_adapter)) throw new Error("journal event source adapter invalid");
  validateLogicalId(value.subject_mission_id, "journal mission_id", { nullable: true });
  if (!INTENTS.has(value.intent)) throw new Error("journal event intent invalid");
  if (!(value.requested_authority in AUTHORITIES)) throw new Error("journal event authority invalid");
  validatePayloadRef(value.payload_ref);
  validateLogicalId(value.correlation_id, "journal correlation_id");
  return value;
}

function receipt({ eventId = null, requestId = null, missionId = null, status, canonicalStatus = null, reasonCode = null, idempotencyDigest = null, journalSeq = null }) {
  if (!EVENT_STATUS_SET.has(status)) throw new Error("invalid receipt status");
  return {
    protocol: EVENT_RECEIPT_PROTOCOL,
    schema_version: EVENT_RECEIPT_SCHEMA_VERSION,
    event_id: eventId,
    request_id: requestId,
    mission_id: missionId,
    status,
    canonical_status: canonicalStatus,
    reason_code: reasonCode,
    idempotency_digest: idempotencyDigest,
    journal_seq: journalSeq,
  };
}

function safeEchoId(value) {
  try { return validateLogicalId(value, "id", { nullable: true }); } catch { return null; }
}

function rejectionReceipt(input, error) {
  return receipt({
    eventId: safeEchoId(input?.event_id ?? null),
    requestId: safeEchoId(input?.request_id ?? null),
    missionId: safeEchoId(input?.subject?.mission_id ?? null),
    status: "REJECTED",
    canonicalStatus: "REJECTED",
    reasonCode: error?.code || "INVALID_EVENT_ENVELOPE",
  });
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink?.() || stat.isReparsePoint?.()) throw new MissionCoreError("UNSAFE_STATE_PATH", "state directory is unsafe");
}

function ensureRegularFile(file, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink?.() || stat.isReparsePoint?.() || (Number.isInteger(stat.nlink) && stat.nlink > 1)) {
    throw new MissionCoreError("UNSAFE_STATE_PATH", `${label} is not a private regular file`);
  }
  return stat;
}

function readJsonFile(file, label) {
  ensureRegularFile(file, label);
  let value;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new MissionCoreError("CORRUPT_DURABLE_STATE", `${label} is not valid JSON`); }
  return value;
}

function encodedJson(value) {
  return Buffer.from(`${canonical(value)}\n`, "utf8");
}

function writeAllAndSync(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (!Number.isInteger(written) || written <= 0) throw new Error("durable write made no progress");
    offset += written;
  }
  fs.fsyncSync(fd);
}

function writeExclusiveJson(file, value) {
  ensureDirectory(path.dirname(file));
  let fd;
  try {
    fd = fs.openSync(file, "wx", 0o600);
    writeAllAndSync(fd, encodedJson(value));
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* preserve original error */ } }
  }
}

function atomicWriteJson(file, value) {
  ensureDirectory(path.dirname(file));
  const temp = path.join(path.dirname(file), `.owned.tmp-${process.pid}-${crypto.randomUUID()}`);
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    writeAllAndSync(fd, encodedJson(value));
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* preserve original error */ } }
    if (fs.existsSync(temp)) { try { fs.unlinkSync(temp); } catch { /* best effort cleanup */ } }
  }
}

function validateRecord(record, { verifyHash = true } = {}) {
  exactKeys(record, EVENT_RECORD_KEYS, "event record");
  if (record.protocol !== EVENT_RECORD_PROTOCOL || record.schema_version !== EVENT_RECORD_SCHEMA_VERSION) throw new Error("unsupported event record schema");
  if (!Number.isInteger(record.journal_seq) || record.journal_seq < 1 || record.journal_seq > MAX_JOURNAL_RECORDS) throw new Error("invalid event record sequence");
  validateLogicalId(record.event_id, "journal event_id");
  validateLogicalId(record.request_id, "journal request_id");
  validateLogicalId(record.mission_id, "journal mission_id");
  if (typeof record.idempotency_digest !== "string" || !DIGEST.test(record.idempotency_digest)) throw new Error("invalid idempotency digest");
  if (!EVENT_KINDS.has(record.kind)) throw new Error("invalid event record kind");
  validateJournalEvent(record.event);
  if (!EVENT_STATUS_SET.has(record.status)) throw new Error("invalid persisted event status");
  if (record.reason_code !== null) validateLogicalId(record.reason_code, "reason_code");
  validateTimestamp(record.committed_at, "committed_at");
  if (record.previous_record_hash !== null && (typeof record.previous_record_hash !== "string" || !DIGEST.test(record.previous_record_hash))) throw new Error("invalid previous record hash");
  if (typeof record.record_hash !== "string" || !DIGEST.test(record.record_hash)) throw new Error("invalid record hash");
  if (verifyHash && sha256(withoutHash(record, "record_hash")) !== record.record_hash) throw new Error("event record hash mismatch");
  return record;
}

function readJournalDirectory(journalDir) {
  ensureDirectory(journalDir);
  const entries = fs.readdirSync(journalDir, { withFileTypes: true });
  if (entries.length > MAX_JOURNAL_RECORDS) throw new MissionCoreError("JOURNAL_BOUNDS_EXCEEDED", "event journal exceeds record bound");
  const files = [];
  let bytes = 0;
  for (const entry of entries) {
    const match = JOURNAL_FILE.exec(entry.name);
    if (!match || !entry.isFile() || entry.isSymbolicLink()) throw new MissionCoreError("CORRUPT_EVENT_JOURNAL", "event journal contains an unexpected entry");
    const file = path.join(journalDir, entry.name);
    const stat = ensureRegularFile(file, "event record");
    if (stat.size > MAX_RECORD_BYTES) throw new MissionCoreError("JOURNAL_BOUNDS_EXCEEDED", "event record exceeds byte bound");
    bytes += stat.size;
    if (bytes > MAX_JOURNAL_BYTES) throw new MissionCoreError("JOURNAL_BOUNDS_EXCEEDED", "event journal exceeds byte bound");
    files.push({ file, seq: Number(match[1]) });
  }
  files.sort((a, b) => a.seq - b.seq);
  const records = [];
  const states = new Map();
  for (let index = 0; index < files.length; index += 1) {
    const expectedSeq = index + 1;
    const item = files[index];
    if (item.seq !== expectedSeq) throw new MissionCoreError("CORRUPT_EVENT_JOURNAL", `event journal sequence gap at ${expectedSeq}`);
    let record;
    try { record = readJsonFile(item.file, "event record"); validateRecord(record); }
    catch (error) { throw new MissionCoreError("CORRUPT_EVENT_JOURNAL", String(error?.message || error)); }
    if (record.journal_seq !== item.seq) throw new MissionCoreError("CORRUPT_EVENT_JOURNAL", "event record filename/sequence mismatch");
    const previous = records.at(-1) || null;
    if (record.previous_record_hash !== (previous?.record_hash || null)) throw new MissionCoreError("CORRUPT_EVENT_JOURNAL", "event journal hash chain mismatch");
    if (previous && Date.parse(record.committed_at) < Date.parse(previous.committed_at)) throw new MissionCoreError("CORRUPT_EVENT_JOURNAL", "event journal timestamp moved backwards");
    const eventState = states.get(record.event_id);
    if (!eventState) {
      if (record.status !== "RECEIVED") throw new MissionCoreError("CORRUPT_EVENT_JOURNAL", "event lifecycle must start at RECEIVED");
      states.set(record.event_id, { status: record.status, request_id: record.request_id, mission_id: record.mission_id, idempotency_digest: record.idempotency_digest, kind: record.kind, event: canonical(record.event) });
    } else {
      if (record.request_id !== eventState.request_id || record.mission_id !== eventState.mission_id || record.idempotency_digest !== eventState.idempotency_digest || record.kind !== eventState.kind || canonical(record.event) !== eventState.event) {
        throw new MissionCoreError("CORRUPT_EVENT_JOURNAL", "event identity drifted across lifecycle records");
      }
      if (record.status === "DUPLICATE") {
        if (["RECEIVED", "ACCEPTED"].includes(eventState.status)) throw new MissionCoreError("CORRUPT_EVENT_JOURNAL", "duplicate receipt preceded canonical admission outcome");
      } else {
        if (!ALLOWED_TRANSITIONS[eventState.status]?.has(record.status)) throw new MissionCoreError("CORRUPT_EVENT_JOURNAL", `invalid event lifecycle transition ${eventState.status}->${record.status}`);
        eventState.status = record.status;
      }
    }
    records.push(record);
  }
  return records;
}

function appendJournalRecord(journalDir, draft, nowIso) {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const records = readJournalDirectory(journalDir);
    const previous = records.at(-1) || null;
    const journalSeq = records.length + 1;
    const committedAt = nowIso();
    const record = {
      protocol: EVENT_RECORD_PROTOCOL,
      schema_version: EVENT_RECORD_SCHEMA_VERSION,
      journal_seq: journalSeq,
      event_id: draft.event_id,
      request_id: draft.request_id,
      mission_id: draft.mission_id,
      idempotency_digest: draft.idempotency_digest,
      kind: draft.kind,
      event: { ...draft.event, payload_ref: { ...draft.event.payload_ref } },
      status: draft.status,
      reason_code: draft.reason_code ?? null,
      committed_at: committedAt,
      previous_record_hash: previous?.record_hash || null,
      record_hash: null,
    };
    record.record_hash = sha256(withoutHash(record, "record_hash"));
    const file = path.join(journalDir, `${String(journalSeq).padStart(8, "0")}.json`);
    try {
      writeExclusiveJson(file, record);
      return record;
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      throw error;
    }
  }
  throw new MissionCoreError("JOURNAL_CONTENTION", "unable to reserve event journal sequence");
}

function withSnapshotHash(snapshot) {
  const value = { ...snapshot, snapshot_hash: null };
  value.snapshot_hash = sha256(withoutHash(value, "snapshot_hash"));
  return value;
}

function validateFollowup(value) {
  exactKeys(value, FOLLOWUP_KEYS, "mission followup");
  validateLogicalId(value.event_id, "followup event_id");
  validateLogicalId(value.request_id, "followup request_id");
  validatePayloadRef(value.payload_ref);
  validateLogicalId(value.correlation_id, "followup correlation_id");
  if (!(value.requested_authority in AUTHORITIES)) throw new Error("followup authority invalid");
  validateTimestamp(value.applied_at, "followup applied_at");
  if (!Number.isInteger(value.applied_journal_seq) || value.applied_journal_seq < 1) throw new Error("followup journal sequence invalid");
}

function validateSnapshot(snapshot, { verifyHash = true } = {}) {
  exactKeys(snapshot, SNAPSHOT_KEYS, "mission snapshot");
  if (snapshot.protocol !== MISSION_SNAPSHOT_PROTOCOL || snapshot.schema_version !== MISSION_SNAPSHOT_SCHEMA_VERSION) throw new Error("unsupported mission snapshot schema");
  validateLogicalId(snapshot.mission_id, "snapshot mission_id");
  validateLogicalId(snapshot.initial_request_id, "snapshot initial_request_id");
  validateLogicalId(snapshot.initial_event_id, "snapshot initial_event_id");
  if (!INTENTS.has(snapshot.intent)) throw new Error("snapshot intent invalid");
  if (!(snapshot.authority_ceiling in AUTHORITIES)) throw new Error("snapshot authority invalid");
  if (!(snapshot.status === "OPEN" || RESULT_STATUSES.has(snapshot.status))) throw new Error("snapshot status invalid");
  validateTimestamp(snapshot.created_at, "snapshot created_at");
  if (!Number.isInteger(snapshot.last_journal_seq) || snapshot.last_journal_seq < 1) throw new Error("snapshot journal sequence invalid");
  if (!Array.isArray(snapshot.applied_event_ids) || !snapshot.applied_event_ids.length || snapshot.applied_event_ids.length > MAX_JOURNAL_RECORDS) throw new Error("snapshot applied events invalid");
  if (!Array.isArray(snapshot.deferred_event_ids) || snapshot.deferred_event_ids.length > MAX_JOURNAL_RECORDS) throw new Error("snapshot deferred events invalid");
  for (const id of snapshot.applied_event_ids) validateLogicalId(id, "snapshot event id");
  for (const id of snapshot.deferred_event_ids) validateLogicalId(id, "snapshot deferred event id");
  if (!Array.isArray(snapshot.followups) || snapshot.followups.length > MAX_JOURNAL_RECORDS) throw new Error("snapshot followups invalid");
  for (const followup of snapshot.followups) validateFollowup(followup);
  if (snapshot.result_id !== null) validateLogicalId(snapshot.result_id, "snapshot result_id");
  if (snapshot.result_status !== null && !RESULT_STATUSES.has(snapshot.result_status)) throw new Error("snapshot result status invalid");
  if (snapshot.completed_at !== null) validateTimestamp(snapshot.completed_at, "snapshot completed_at");
  if ((snapshot.result_id === null) !== (snapshot.result_status === null) || (snapshot.result_id === null) !== (snapshot.completed_at === null)) throw new Error("snapshot terminal linkage incomplete");
  if (snapshot.result_id === null && snapshot.status !== "OPEN") throw new Error("snapshot terminal status lacks result");
  if (snapshot.result_id !== null && snapshot.status !== snapshot.result_status) throw new Error("snapshot terminal status/result mismatch");
  if (typeof snapshot.snapshot_hash !== "string" || !DIGEST.test(snapshot.snapshot_hash)) throw new Error("snapshot hash invalid");
  if (verifyHash && sha256(withoutHash(snapshot, "snapshot_hash")) !== snapshot.snapshot_hash) throw new Error("snapshot hash mismatch");
  return snapshot;
}

function eventLifecycle(records) {
  const events = new Map();
  for (const record of records) {
    const existing = events.get(record.event_id) || {
      event_id: record.event_id,
      request_id: record.request_id,
      mission_id: record.mission_id,
      idempotency_digest: record.idempotency_digest,
      kind: record.kind,
      event: record.event,
      status: null,
      reason_code: null,
      journal_seq: record.journal_seq,
      records: [],
      duplicate_count: 0,
      last_duplicate_journal_seq: null,
    };
    if (record.status === "DUPLICATE") {
      existing.duplicate_count += 1;
      existing.last_duplicate_journal_seq = record.journal_seq;
    } else {
      existing.status = record.status;
      existing.reason_code = record.reason_code;
      existing.journal_seq = record.journal_seq;
    }
    existing.records.push(record.journal_seq);
    events.set(record.event_id, existing);
  }
  return events;
}

function resultMap(results) {
  const map = new Map();
  for (const result of results) {
    if (map.has(result.mission_id)) throw new Error("multiple MissionResults for one mission");
    map.set(result.mission_id, result);
  }
  return map;
}

export function reduceMissionJournal(records, { results = [] } = {}) {
  const missions = new Map();
  for (const record of records) {
    validateRecord(record);
    if (record.kind === "operator.request.submitted" && record.status === "APPLIED") {
      if (missions.has(record.mission_id)) throw new Error("new Mission event attempted to reuse mission identity");
      if (record.event.subject_mission_id !== null) throw new Error("new Mission event contains existing mission subject");
      missions.set(record.mission_id, {
        protocol: MISSION_SNAPSHOT_PROTOCOL,
        schema_version: MISSION_SNAPSHOT_SCHEMA_VERSION,
        mission_id: record.mission_id,
        initial_request_id: record.request_id,
        initial_event_id: record.event_id,
        intent: record.event.intent,
        authority_ceiling: record.event.requested_authority,
        status: "OPEN",
        created_at: record.event.occurred_at,
        last_journal_seq: record.journal_seq,
        applied_event_ids: [record.event_id],
        deferred_event_ids: [],
        followups: [],
        result_id: null,
        result_status: null,
        completed_at: null,
        snapshot_hash: null,
      });
      continue;
    }
    if (record.kind !== "operator.followup.submitted") continue;
    if (!["DEFERRED", "APPLIED"].includes(record.status)) continue;
    const mission = missions.get(record.mission_id);
    if (!mission) throw new Error("follow-up references mission before durable Mission creation");
    if (record.event.subject_mission_id !== record.mission_id) throw new Error("follow-up cross-routing mismatch");
    mission.last_journal_seq = record.journal_seq;
    if (record.status === "DEFERRED") {
      if (!mission.deferred_event_ids.includes(record.event_id) && !mission.applied_event_ids.includes(record.event_id)) mission.deferred_event_ids.push(record.event_id);
    } else {
      mission.deferred_event_ids = mission.deferred_event_ids.filter((id) => id !== record.event_id);
      if (!mission.applied_event_ids.includes(record.event_id)) {
        mission.applied_event_ids.push(record.event_id);
        mission.followups.push({
          event_id: record.event_id,
          request_id: record.request_id,
          payload_ref: { ...record.event.payload_ref },
          correlation_id: record.event.correlation_id,
          requested_authority: record.event.requested_authority,
          applied_at: record.committed_at,
          applied_journal_seq: record.journal_seq,
        });
      }
    }
  }
  const resultsByMission = resultMap(results);
  for (const [missionId, result] of resultsByMission) {
    const mission = missions.get(missionId);
    if (!mission) throw new Error("MissionResult references unknown mission");
    mission.status = result.status;
    mission.result_id = result.result_id;
    mission.result_status = result.status;
    mission.completed_at = result.completed_at;
  }
  return new Map([...missions.entries()].map(([id, snapshot]) => [id, withSnapshotHash(snapshot)]));
}

function validateCompletionInput(input) {
  exactKeys(input, COMPLETION_INPUT_KEYS, "MissionResult input");
  if (!RESULT_STATUSES.has(input.status)) throw new MissionCoreError("INVALID_MISSION_RESULT", "unsupported MissionResult status");
  validateBoundedString(input.summary, "MissionResult summary", 16000, { allowEmpty: false });
  validateStringArray(input.changed_surface, "changed_surface");
  validateStringArray(input.evidence_refs, "evidence_refs");
  validateStringArray(input.remaining_limits, "remaining_limits");
  exactKeys(input.episode_aggregate, EPISODE_AGGREGATE_KEYS, "episode_aggregate");
  if (!Number.isInteger(input.episode_aggregate.episode_count) || input.episode_aggregate.episode_count < 0 || input.episode_aggregate.episode_count > 1000000) throw new MissionCoreError("INVALID_MISSION_RESULT", "episode_count invalid");
  if (!Number.isInteger(input.episode_aggregate.escalation_count) || input.episode_aggregate.escalation_count < 0 || input.episode_aggregate.escalation_count > input.episode_aggregate.episode_count) throw new MissionCoreError("INVALID_MISSION_RESULT", "escalation_count invalid");
  validateStringArray(input.episode_aggregate.runtime_classes, "runtime_classes", { maxItems: 32, maxChars: 64 });
  return {
    status: input.status,
    summary: input.summary,
    changed_surface: [...input.changed_surface],
    evidence_refs: [...input.evidence_refs],
    remaining_limits: [...input.remaining_limits],
    episode_aggregate: {
      episode_count: input.episode_aggregate.episode_count,
      runtime_classes: [...input.episode_aggregate.runtime_classes],
      escalation_count: input.episode_aggregate.escalation_count,
    },
  };
}

function completionSemantic(result) {
  return {
    status: result.status,
    summary: result.summary,
    changed_surface: result.changed_surface,
    evidence_refs: result.evidence_refs,
    remaining_limits: result.remaining_limits,
    episode_aggregate: result.episode_aggregate,
  };
}

function validateResult(result, { verifyHash = true } = {}) {
  exactKeys(result, RESULT_KEYS, "MissionResult");
  if (result.protocol !== MISSION_RESULT_PROTOCOL || result.schema_version !== MISSION_RESULT_SCHEMA_VERSION) throw new Error("unsupported MissionResult schema");
  validateLogicalId(result.request_id, "MissionResult request_id");
  validateLogicalId(result.mission_id, "MissionResult mission_id");
  validateLogicalId(result.result_id, "MissionResult result_id");
  validateCompletionInput(completionSemantic(result));
  validateTimestamp(result.completed_at, "MissionResult completed_at");
  if (typeof result.result_hash !== "string" || !DIGEST.test(result.result_hash)) throw new Error("MissionResult hash invalid");
  if (verifyHash && sha256(withoutHash(result, "result_hash")) !== result.result_hash) throw new Error("MissionResult hash mismatch");
  const stableIdentity = sha256({ request_id: result.request_id, mission_id: result.mission_id, ...completionSemantic(result), completed_at: result.completed_at });
  if (result.result_id !== `result-${stableIdentity.slice(0, 32)}`) throw new Error("MissionResult identity mismatch");
  return result;
}

function withIdempotencyHash(record) {
  const value = { ...record, record_hash: null };
  value.record_hash = sha256(withoutHash(value, "record_hash"));
  return value;
}

function validateIdempotencyRecord(record, { verifyHash = true } = {}) {
  exactKeys(record, IDEMPOTENCY_KEYS, "idempotency record");
  if (record.protocol !== IDEMPOTENCY_RECORD_PROTOCOL || record.schema_version !== IDEMPOTENCY_RECORD_SCHEMA_VERSION) throw new Error("unsupported idempotency schema");
  if (typeof record.idempotency_digest !== "string" || !DIGEST.test(record.idempotency_digest)) throw new Error("idempotency digest invalid");
  if (typeof record.event_digest !== "string" || !DIGEST.test(record.event_digest)) throw new Error("event digest invalid");
  if (!new Set(["PENDING", "COMMITTED"]).has(record.state)) throw new Error("idempotency state invalid");
  validateLogicalId(record.event_id, "idempotency event_id");
  validateLogicalId(record.request_id, "idempotency request_id");
  validateLogicalId(record.mission_id, "idempotency mission_id");
  if (!EVENT_STATUS_SET.has(record.status)) throw new Error("idempotency status invalid");
  if (record.reason_code !== null) validateLogicalId(record.reason_code, "idempotency reason_code");
  if (record.journal_seq !== null && (!Number.isInteger(record.journal_seq) || record.journal_seq < 1)) throw new Error("idempotency journal sequence invalid");
  validateTimestamp(record.created_at, "idempotency created_at");
  validateTimestamp(record.updated_at, "idempotency updated_at");
  if (typeof record.record_hash !== "string" || !DIGEST.test(record.record_hash)) throw new Error("idempotency hash invalid");
  if (verifyHash && sha256(withoutHash(record, "record_hash")) !== record.record_hash) throw new Error("idempotency hash mismatch");
  return record;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class DevExecMissionStore {
  constructor({ stateDir, now = () => new Date() } = {}) {
    if (typeof stateDir !== "string" || !stateDir.trim()) throw new MissionCoreError("STATE_DIR_REQUIRED", "stateDir is required");
    this.stateDir = path.resolve(stateDir);
    this.journalDir = path.join(this.stateDir, "event-journal");
    this.missionsDir = path.join(this.stateDir, "missions");
    this.idempotencyDir = path.join(this.stateDir, "idempotency");
    this.now = now;
    ensureDirectory(this.stateDir);
    ensureDirectory(this.journalDir);
    ensureDirectory(this.missionsDir);
    ensureDirectory(this.idempotencyDir);
  }

  nowIso() {
    let value;
    try {
      const current = this.now();
      value = current instanceof Date ? current.toISOString() : String(current);
      validateTimestamp(value, "store timestamp");
    } catch { throw new MissionCoreError("INVALID_STORE_CLOCK", "store clock returned an invalid timestamp"); }
    return value;
  }

  idempotencyDigest(event) {
    return sha256(`${event.source.binding_id}\u0000${event.idempotency_key}`);
  }

  eventDigest(event) {
    return sha256(event);
  }

  missionIdForNewEvent(event, digest = this.idempotencyDigest(event)) {
    return `mission-${digest.slice(0, 32)}`;
  }

  idempotencyFile(digest) {
    return path.join(this.idempotencyDir, `${digest}.json`);
  }

  missionDir(missionId) {
    validateLogicalId(missionId, "mission_id");
    return path.join(this.missionsDir, missionId);
  }

  snapshotFile(missionId) {
    return path.join(this.missionDir(missionId), "snapshot.json");
  }

  resultFile(missionId) {
    return path.join(this.missionDir(missionId), "result.json");
  }

  readJournal() {
    return clone(readJournalDirectory(this.journalDir));
  }

  readAllResults() {
    const results = [];
    for (const entry of fs.readdirSync(this.missionsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new MissionCoreError("CORRUPT_DURABLE_STATE", "missions directory contains an unexpected entry");
      validateLogicalId(entry.name, "mission directory id");
      const dir = this.missionDir(entry.name);
      const allowed = new Set(["snapshot.json", "result.json"]);
      for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!allowed.has(child.name) || !child.isFile() || child.isSymbolicLink()) throw new MissionCoreError("CORRUPT_DURABLE_STATE", "mission directory contains an unexpected entry");
      }
      const resultPath = this.resultFile(entry.name);
      if (fs.existsSync(resultPath)) {
        const result = readJsonFile(resultPath, "MissionResult");
        try { validateResult(result); } catch (error) { throw new MissionCoreError("CORRUPT_MISSION_RESULT", String(error?.message || error)); }
        if (result.mission_id !== entry.name) throw new MissionCoreError("CORRUPT_MISSION_RESULT", "MissionResult path/identity mismatch");
        results.push(result);
      }
    }
    return results;
  }

  expectedSnapshots() {
    const records = readJournalDirectory(this.journalDir);
    const results = this.readAllResults();
    try { return reduceMissionJournal(records, { results }); }
    catch (error) { throw new MissionCoreError("CORRUPT_DURABLE_STATE", String(error?.message || error)); }
  }

  recoverSnapshots() {
    const expected = this.expectedSnapshots();
    const actualNames = fs.readdirSync(this.missionsDir, { withFileTypes: true }).map((entry) => entry.name).sort();
    for (const name of actualNames) {
      validateLogicalId(name, "mission directory id");
      if (!expected.has(name)) throw new MissionCoreError("CORRUPT_DURABLE_STATE", "unexpected mission directory has no journal authority");
    }
    for (const [missionId, snapshot] of expected) {
      const dir = this.missionDir(missionId);
      ensureDirectory(dir);
      const file = this.snapshotFile(missionId);
      if (!fs.existsSync(file)) {
        atomicWriteJson(file, snapshot);
        continue;
      }
      let stored;
      try { stored = readJsonFile(file, "mission snapshot"); validateSnapshot(stored); }
      catch (error) { throw new MissionCoreError("CORRUPT_MISSION_SNAPSHOT", String(error?.message || error)); }
      if (stored.mission_id !== missionId) throw new MissionCoreError("CORRUPT_MISSION_SNAPSHOT", "mission snapshot path/identity mismatch");
      if (canonical(stored) !== canonical(snapshot)) {
        // A structurally valid, self-hashed snapshot may lag an already durable
        // journal/result commit after a crash. The journal/result pair is the
        // authority, so this is a recoverable projection lag rather than a replay.
        atomicWriteJson(file, snapshot);
      }
    }
    return expected;
  }

  readIdempotencyRecords() {
    const records = [];
    for (const entry of fs.readdirSync(this.idempotencyDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const match = IDEMPOTENCY_FILE.exec(entry.name);
      if (!match || !entry.isFile() || entry.isSymbolicLink()) throw new MissionCoreError("CORRUPT_IDEMPOTENCY_STATE", "idempotency directory contains an unexpected entry");
      const value = readJsonFile(path.join(this.idempotencyDir, entry.name), "idempotency record");
      try { validateIdempotencyRecord(value); } catch (error) { throw new MissionCoreError("CORRUPT_IDEMPOTENCY_STATE", String(error?.message || error)); }
      if (value.idempotency_digest !== match[1]) throw new MissionCoreError("CORRUPT_IDEMPOTENCY_STATE", "idempotency filename/digest mismatch");
      records.push(value);
    }
    return records;
  }

  verifyDurableState({ recoverStaleSnapshots = false } = {}) {
    try {
      const expected = recoverStaleSnapshots ? this.recoverSnapshots() : this.expectedSnapshots();
      if (!recoverStaleSnapshots) {
        const names = fs.readdirSync(this.missionsDir, { withFileTypes: true });
        if (names.length !== expected.size) throw new MissionCoreError("STALE_MISSION_SNAPSHOT", "mission snapshot set differs from journal");
        for (const entry of names) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) throw new MissionCoreError("CORRUPT_DURABLE_STATE", "missions directory contains an unexpected entry");
          let snapshot;
          try { snapshot = readJsonFile(this.snapshotFile(entry.name), "mission snapshot"); validateSnapshot(snapshot); }
          catch (error) { throw new MissionCoreError("CORRUPT_MISSION_SNAPSHOT", String(error?.message || error)); }
          const wanted = expected.get(entry.name);
          if (!wanted || canonical(snapshot) !== canonical(wanted)) throw new MissionCoreError("STALE_MISSION_SNAPSHOT", "mission snapshot differs from durable journal/result authority");
        }
      }
      const idempotency = this.readIdempotencyRecords();
      const pending = idempotency.filter((record) => record.state === "PENDING");
      if (pending.length) return { valid: false, classification: "INCOMPLETE_IDEMPOTENCY_CLAIM", pending: pending.map((record) => record.idempotency_digest), mission_count: expected.size, event_record_count: this.readJournal().length };
      return { valid: true, classification: "OK", pending: [], mission_count: expected.size, event_record_count: this.readJournal().length };
    } catch (error) {
      return { valid: false, classification: error?.code || "CORRUPT_DURABLE_STATE", error: String(error?.message || error), pending: [], mission_count: 0, event_record_count: 0 };
    }
  }

  assertHealthy() {
    const state = this.verifyDurableState({ recoverStaleSnapshots: true });
    if (!state.valid) throw new MissionCoreError(state.classification, state.error || state.classification);
    return state;
  }

  readMission(missionId) {
    validateLogicalId(missionId, "mission_id");
    this.assertHealthy();
    const file = this.snapshotFile(missionId);
    if (!fs.existsSync(file)) return null;
    const snapshot = readJsonFile(file, "mission snapshot");
    try { validateSnapshot(snapshot); } catch (error) { throw new MissionCoreError("CORRUPT_MISSION_SNAPSHOT", String(error?.message || error)); }
    return clone(snapshot);
  }

  listMissions() {
    this.assertHealthy();
    const expected = this.expectedSnapshots();
    return [...expected.values()].sort((a, b) => a.mission_id.localeCompare(b.mission_id)).map(clone);
  }

  listEvents({ missionId = null } = {}) {
    if (missionId !== null) validateLogicalId(missionId, "mission_id");
    this.assertHealthy();
    const lifecycle = eventLifecycle(readJournalDirectory(this.journalDir));
    return [...lifecycle.values()]
      .filter((event) => missionId === null || event.mission_id === missionId)
      .sort((a, b) => a.records[0] - b.records[0])
      .map((event) => clone(event));
  }

  readEvent(eventId) {
    validateLogicalId(eventId, "event_id");
    return this.listEvents().find((event) => event.event_id === eventId) || null;
  }

  listIdempotencyReceipts() {
    this.assertHealthy();
    return this.readIdempotencyRecords().map((record) => ({
      idempotency_digest: record.idempotency_digest,
      state: record.state,
      event_id: record.event_id,
      request_id: record.request_id,
      mission_id: record.mission_id,
      status: record.status,
      reason_code: record.reason_code,
      journal_seq: record.journal_seq,
    }));
  }

  readMissionResult(missionId) {
    validateLogicalId(missionId, "mission_id");
    this.assertHealthy();
    const file = this.resultFile(missionId);
    if (!fs.existsSync(file)) return null;
    const result = readJsonFile(file, "MissionResult");
    try { validateResult(result); } catch (error) { throw new MissionCoreError("CORRUPT_MISSION_RESULT", String(error?.message || error)); }
    return clone(result);
  }

  loadIdempotencyRecord(file) {
    const value = readJsonFile(file, "idempotency record");
    try { validateIdempotencyRecord(value); } catch (error) { throw new MissionCoreError("CORRUPT_IDEMPOTENCY_STATE", String(error?.message || error)); }
    return value;
  }

  duplicateOrConflict(event, digest, eventDigest, existing) {
    if (existing.state === "PENDING") {
      return receipt({ eventId: event.event_id, requestId: event.request_id, missionId: existing.mission_id, status: "BLOCKED", canonicalStatus: "BLOCKED", reasonCode: "IDEMPOTENCY_IN_FLIGHT", idempotencyDigest: digest, journalSeq: existing.journal_seq });
    }
    this.assertHealthy();
    if (existing.event_digest !== eventDigest || existing.event_id !== event.event_id || existing.request_id !== event.request_id) {
      return receipt({ eventId: event.event_id, requestId: event.request_id, missionId: existing.mission_id, status: "BLOCKED", canonicalStatus: existing.status, reasonCode: "IDEMPOTENCY_CONFLICT", idempotencyDigest: digest, journalSeq: existing.journal_seq });
    }
    const duplicate = appendJournalRecord(this.journalDir, {
      event_id: existing.event_id,
      request_id: existing.request_id,
      mission_id: existing.mission_id,
      idempotency_digest: digest,
      kind: event.kind,
      event: projectEvent(event),
      status: "DUPLICATE",
      reason_code: "IDEMPOTENT_REPLAY",
    }, () => this.nowIso());
    return receipt({ eventId: existing.event_id, requestId: existing.request_id, missionId: existing.mission_id, status: "DUPLICATE", canonicalStatus: existing.status, reasonCode: "IDEMPOTENT_REPLAY", idempotencyDigest: digest, journalSeq: duplicate.journal_seq });
  }

  finalizeIdempotency(file, pending, { status, reasonCode = null, journalSeq }) {
    const updatedAt = this.nowIso();
    const committed = withIdempotencyHash({
      ...withoutHash(pending, "record_hash"),
      state: "COMMITTED",
      status,
      reason_code: reasonCode,
      journal_seq: journalSeq,
      updated_at: updatedAt,
      record_hash: null,
    });
    atomicWriteJson(file, committed);
    return committed;
  }

  submitOperatorEvent(input) {
    let event;
    try { event = validateOperatorEvent(input); }
    catch (error) { return rejectionReceipt(input, error); }

    const digest = this.idempotencyDigest(event);
    const eventDigest = this.eventDigest(event);
    const missionId = event.kind === "operator.request.submitted" ? this.missionIdForNewEvent(event, digest) : event.subject.mission_id;
    const idempotencyFile = this.idempotencyFile(digest);

    if (fs.existsSync(idempotencyFile)) {
      let existing;
      try { existing = this.loadIdempotencyRecord(idempotencyFile); }
      catch (error) { return receipt({ eventId: event.event_id, requestId: event.request_id, missionId: missionId || null, status: "BLOCKED", canonicalStatus: "BLOCKED", reasonCode: error.code || "CORRUPT_IDEMPOTENCY_STATE", idempotencyDigest: digest }); }
      return this.duplicateOrConflict(event, digest, eventDigest, existing);
    }

    try { this.assertHealthy(); }
    catch (error) { return receipt({ eventId: event.event_id, requestId: event.request_id, missionId: missionId || null, status: "BLOCKED", canonicalStatus: "BLOCKED", reasonCode: error.code || "CORRUPT_DURABLE_STATE", idempotencyDigest: digest }); }

    if (missionId === null) {
      // A structurally valid follow-up without an exact Mission identity is
      // rejected without creating a path-bearing durable claim.
      return receipt({ eventId: event.event_id, requestId: event.request_id, missionId: null, status: "REJECTED", canonicalStatus: "REJECTED", reasonCode: "MISSION_ID_REQUIRED", idempotencyDigest: digest });
    }

    const createdAt = this.nowIso();
    const pending = withIdempotencyHash({
      protocol: IDEMPOTENCY_RECORD_PROTOCOL,
      schema_version: IDEMPOTENCY_RECORD_SCHEMA_VERSION,
      idempotency_digest: digest,
      event_digest: eventDigest,
      state: "PENDING",
      event_id: event.event_id,
      request_id: event.request_id,
      mission_id: missionId,
      status: "RECEIVED",
      reason_code: null,
      journal_seq: null,
      created_at: createdAt,
      updated_at: createdAt,
      record_hash: null,
    });
    try { writeExclusiveJson(idempotencyFile, pending); }
    catch (error) {
      if (error?.code === "EEXIST") {
        try { return this.duplicateOrConflict(event, digest, eventDigest, this.loadIdempotencyRecord(idempotencyFile)); }
        catch (inner) { return receipt({ eventId: event.event_id, requestId: event.request_id, missionId, status: "BLOCKED", canonicalStatus: "BLOCKED", reasonCode: inner.code || "CORRUPT_IDEMPOTENCY_STATE", idempotencyDigest: digest }); }
      }
      throw error;
    }

    const eventProjection = projectEvent(event);
    const baseDraft = { event_id: event.event_id, request_id: event.request_id, mission_id: missionId, idempotency_digest: digest, kind: event.kind, event: eventProjection };
    let last = appendJournalRecord(this.journalDir, { ...baseDraft, status: "RECEIVED", reason_code: null }, () => this.nowIso());

    if (event.kind === "operator.request.submitted" && event.subject.mission_id !== null) {
      last = appendJournalRecord(this.journalDir, { ...baseDraft, status: "REJECTED", reason_code: "NEW_MISSION_SUBJECT_FORBIDDEN" }, () => this.nowIso());
      this.finalizeIdempotency(idempotencyFile, pending, { status: "REJECTED", reasonCode: "NEW_MISSION_SUBJECT_FORBIDDEN", journalSeq: last.journal_seq });
      return receipt({ eventId: event.event_id, requestId: event.request_id, missionId, status: "REJECTED", canonicalStatus: "REJECTED", reasonCode: "NEW_MISSION_SUBJECT_FORBIDDEN", idempotencyDigest: digest, journalSeq: last.journal_seq });
    }

    if (event.intent === "CONSULTATION" && event.requested_authority !== "READ_ONLY") {
      last = appendJournalRecord(this.journalDir, { ...baseDraft, status: "BLOCKED", reason_code: "CONSULTATION_AUTHORITY_CONTRADICTION" }, () => this.nowIso());
      this.finalizeIdempotency(idempotencyFile, pending, { status: "BLOCKED", reasonCode: "CONSULTATION_AUTHORITY_CONTRADICTION", journalSeq: last.journal_seq });
      return receipt({ eventId: event.event_id, requestId: event.request_id, missionId, status: "BLOCKED", canonicalStatus: "BLOCKED", reasonCode: "CONSULTATION_AUTHORITY_CONTRADICTION", idempotencyDigest: digest, journalSeq: last.journal_seq });
    }

    if (event.kind === "operator.followup.submitted") {
      // The caller-owned idempotency claim is PENDING at this point. Do not
      // re-enter the public read API (which correctly treats any pending
      // claim as fail-closed); the store was verified immediately before the
      // claim and the journal is revalidated on every append.
      let mission;
      try { mission = this.expectedSnapshots().get(missionId) || null; }
      catch (error) {
        last = appendJournalRecord(this.journalDir, { ...baseDraft, status: "BLOCKED", reason_code: error.code || "MISSION_STATE_UNAVAILABLE" }, () => this.nowIso());
        this.finalizeIdempotency(idempotencyFile, pending, { status: "BLOCKED", reasonCode: error.code || "MISSION_STATE_UNAVAILABLE", journalSeq: last.journal_seq });
        return receipt({ eventId: event.event_id, requestId: event.request_id, missionId, status: "BLOCKED", canonicalStatus: "BLOCKED", reasonCode: error.code || "MISSION_STATE_UNAVAILABLE", idempotencyDigest: digest, journalSeq: last.journal_seq });
      }
      if (!mission) {
        last = appendJournalRecord(this.journalDir, { ...baseDraft, status: "REJECTED", reason_code: "MISSION_NOT_FOUND" }, () => this.nowIso());
        this.finalizeIdempotency(idempotencyFile, pending, { status: "REJECTED", reasonCode: "MISSION_NOT_FOUND", journalSeq: last.journal_seq });
        return receipt({ eventId: event.event_id, requestId: event.request_id, missionId, status: "REJECTED", canonicalStatus: "REJECTED", reasonCode: "MISSION_NOT_FOUND", idempotencyDigest: digest, journalSeq: last.journal_seq });
      }
      if (mission.status !== "OPEN") {
        last = appendJournalRecord(this.journalDir, { ...baseDraft, status: "REJECTED", reason_code: "MISSION_TERMINAL" }, () => this.nowIso());
        this.finalizeIdempotency(idempotencyFile, pending, { status: "REJECTED", reasonCode: "MISSION_TERMINAL", journalSeq: last.journal_seq });
        return receipt({ eventId: event.event_id, requestId: event.request_id, missionId, status: "REJECTED", canonicalStatus: "REJECTED", reasonCode: "MISSION_TERMINAL", idempotencyDigest: digest, journalSeq: last.journal_seq });
      }
      if (AUTHORITIES[event.requested_authority] > AUTHORITIES[mission.authority_ceiling]) {
        last = appendJournalRecord(this.journalDir, { ...baseDraft, status: "BLOCKED", reason_code: "AUTHORITY_CEILING_EXCEEDED" }, () => this.nowIso());
        this.finalizeIdempotency(idempotencyFile, pending, { status: "BLOCKED", reasonCode: "AUTHORITY_CEILING_EXCEEDED", journalSeq: last.journal_seq });
        return receipt({ eventId: event.event_id, requestId: event.request_id, missionId, status: "BLOCKED", canonicalStatus: "BLOCKED", reasonCode: "AUTHORITY_CEILING_EXCEEDED", idempotencyDigest: digest, journalSeq: last.journal_seq });
      }
    }

    last = appendJournalRecord(this.journalDir, { ...baseDraft, status: "ACCEPTED", reason_code: null }, () => this.nowIso());
    if (event.kind === "operator.request.submitted") {
      last = appendJournalRecord(this.journalDir, { ...baseDraft, status: "APPLIED", reason_code: null }, () => this.nowIso());
      this.recoverSnapshots();
      this.finalizeIdempotency(idempotencyFile, pending, { status: "APPLIED", reasonCode: null, journalSeq: last.journal_seq });
      return receipt({ eventId: event.event_id, requestId: event.request_id, missionId, status: "APPLIED", canonicalStatus: "APPLIED", reasonCode: null, idempotencyDigest: digest, journalSeq: last.journal_seq });
    }

    last = appendJournalRecord(this.journalDir, { ...baseDraft, status: "DEFERRED", reason_code: "FRESH_NEXT_EPISODE_REQUIRED" }, () => this.nowIso());
    this.recoverSnapshots();
    this.finalizeIdempotency(idempotencyFile, pending, { status: "DEFERRED", reasonCode: "FRESH_NEXT_EPISODE_REQUIRED", journalSeq: last.journal_seq });
    return receipt({ eventId: event.event_id, requestId: event.request_id, missionId, status: "DEFERRED", canonicalStatus: "DEFERRED", reasonCode: "FRESH_NEXT_EPISODE_REQUIRED", idempotencyDigest: digest, journalSeq: last.journal_seq });
  }

  applyDeferredEvent({ mission_id: missionId, event_id: eventId, safe_boundary: safeBoundary } = {}) {
    validateLogicalId(missionId, "mission_id");
    validateLogicalId(eventId, "event_id");
    if (safeBoundary !== "FRESH_NEXT_EPISODE") throw new MissionCoreError("SAFE_BOUNDARY_REQUIRED", "only the FRESH_NEXT_EPISODE seam may apply a deferred operator event");
    this.assertHealthy();
    const lifecycle = eventLifecycle(readJournalDirectory(this.journalDir));
    const event = lifecycle.get(eventId);
    if (!event) throw new MissionCoreError("EVENT_NOT_FOUND", "deferred event not found");
    if (event.mission_id !== missionId || event.event.subject_mission_id !== missionId) throw new MissionCoreError("EVENT_MISSION_MISMATCH", "event belongs to a different exact Mission");
    if (event.kind !== "operator.followup.submitted") throw new MissionCoreError("EVENT_NOT_FOLLOWUP", "only follow-up events use the fresh-next-episode seam");
    if (event.status === "APPLIED") return receipt({ eventId, requestId: event.request_id, missionId, status: "DUPLICATE", canonicalStatus: "APPLIED", reasonCode: "EVENT_ALREADY_APPLIED", idempotencyDigest: event.idempotency_digest, journalSeq: event.journal_seq });
    if (event.status !== "DEFERRED") throw new MissionCoreError("EVENT_NOT_DEFERRED", `event is ${event.status}, not DEFERRED`);
    const baseDraft = { event_id: event.event_id, request_id: event.request_id, mission_id: event.mission_id, idempotency_digest: event.idempotency_digest, kind: event.kind, event: event.event };
    const applied = appendJournalRecord(this.journalDir, { ...baseDraft, status: "APPLIED", reason_code: null }, () => this.nowIso());
    this.recoverSnapshots();
    const idempotencyFile = this.idempotencyFile(event.idempotency_digest);
    const record = this.loadIdempotencyRecord(idempotencyFile);
    if (record.state !== "COMMITTED" || record.event_id !== eventId) throw new MissionCoreError("CORRUPT_IDEMPOTENCY_STATE", "event idempotency linkage is invalid");
    const updated = withIdempotencyHash({ ...withoutHash(record, "record_hash"), status: "APPLIED", reason_code: null, journal_seq: applied.journal_seq, updated_at: this.nowIso(), record_hash: null });
    atomicWriteJson(idempotencyFile, updated);
    return receipt({ eventId, requestId: event.request_id, missionId, status: "APPLIED", canonicalStatus: "APPLIED", reasonCode: null, idempotencyDigest: event.idempotency_digest, journalSeq: applied.journal_seq });
  }

  completeMission(missionId, completionInput) {
    validateLogicalId(missionId, "mission_id");
    const completion = validateCompletionInput(completionInput);
    this.assertHealthy();
    const mission = this.readMission(missionId);
    if (!mission) throw new MissionCoreError("MISSION_NOT_FOUND", "Mission not found");
    const resultPath = this.resultFile(missionId);
    if (fs.existsSync(resultPath)) {
      const existing = readJsonFile(resultPath, "MissionResult");
      try { validateResult(existing); } catch (error) { throw new MissionCoreError("CORRUPT_MISSION_RESULT", String(error?.message || error)); }
      if (canonical(completionSemantic(existing)) !== canonical(completion)) throw new MissionCoreError("MISSION_RESULT_CONFLICT", "canonical MissionResult already committed with different content");
      this.recoverSnapshots();
      return { duplicate: true, status: "DUPLICATE", result: clone(existing) };
    }
    const completedAt = this.nowIso();
    const stableIdentity = sha256({ request_id: mission.initial_request_id, mission_id: missionId, ...completion, completed_at: completedAt });
    const result = {
      protocol: MISSION_RESULT_PROTOCOL,
      schema_version: MISSION_RESULT_SCHEMA_VERSION,
      request_id: mission.initial_request_id,
      mission_id: missionId,
      result_id: `result-${stableIdentity.slice(0, 32)}`,
      status: completion.status,
      summary: completion.summary,
      changed_surface: completion.changed_surface,
      evidence_refs: completion.evidence_refs,
      remaining_limits: completion.remaining_limits,
      episode_aggregate: completion.episode_aggregate,
      completed_at: completedAt,
      result_hash: null,
    };
    result.result_hash = sha256(withoutHash(result, "result_hash"));
    try { writeExclusiveJson(resultPath, result); }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = readJsonFile(resultPath, "MissionResult");
      try { validateResult(existing); } catch (inner) { throw new MissionCoreError("CORRUPT_MISSION_RESULT", String(inner?.message || inner)); }
      if (canonical(completionSemantic(existing)) !== canonical(completion)) throw new MissionCoreError("MISSION_RESULT_CONFLICT", "canonical MissionResult concurrently committed with different content");
      this.recoverSnapshots();
      return { duplicate: true, status: "DUPLICATE", result: clone(existing) };
    }
    this.recoverSnapshots();
    return { duplicate: false, status: "COMMITTED", result: clone(result) };
  }
}

export function createDevExecMissionStore(options) {
  return new DevExecMissionStore(options);
}
