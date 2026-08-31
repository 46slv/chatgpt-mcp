import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Parent-owned recovery journal for the local runtime.
 *
 * This module deliberately stores lifecycle facts only.  It is not a task
 * ledger and does not contain prompts, source, paths, commands, URLs,
 * environment values, process ids, or provider nonces.  Event files are
 * created directly through one exclusive descriptor.  A process killed while
 * writing can therefore leave a malformed final event; readers report that
 * run as malformed.  Files with an owned temporary suffix are ignored by
 * scanners so future writers may use a two-phase implementation safely.
 */

export const RECOVERY_JOURNAL_SCHEMA = "devexec.local-runtime-recovery/v1";
export const RECOVERY_JOURNAL_VERSION = 1;
export const MAX_RUNS = 128;
export const MAX_EVENTS = 4096;
export const MAX_EVENT_BYTES = 64 * 1024;
export const MAX_SCAN_BYTES = 8 * 1024 * 1024;

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const EVENT_FILE = /^(\d{8})\.json$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STATES = Object.freeze([
  "RUN_CREATED", "PREFLIGHT", "LEASE_ACQUIRED", "PROVIDER_STARTED",
  "INFERENCE", "POSTFLIGHT", "TEST", "CLEANUP", "TERMINAL",
  "INTERRUPTED_UNKNOWN", "NEEDS_ATTENTION",
]);
const STATE_SET = new Set(STATES);
const TERMINAL_STATES = new Set(["TERMINAL", "NEEDS_ATTENTION"]);
const TRANSITIONS = Object.freeze({
  RUN_CREATED: new Set(["PREFLIGHT", "CLEANUP", "TERMINAL", "INTERRUPTED_UNKNOWN"]),
  PREFLIGHT: new Set(["LEASE_ACQUIRED", "CLEANUP", "TERMINAL", "INTERRUPTED_UNKNOWN"]),
  LEASE_ACQUIRED: new Set(["PROVIDER_STARTED", "CLEANUP", "TERMINAL", "INTERRUPTED_UNKNOWN"]),
  PROVIDER_STARTED: new Set(["INFERENCE", "CLEANUP", "TERMINAL", "INTERRUPTED_UNKNOWN"]),
  INFERENCE: new Set(["POSTFLIGHT", "CLEANUP", "TERMINAL", "INTERRUPTED_UNKNOWN"]),
  POSTFLIGHT: new Set(["TEST", "CLEANUP", "TERMINAL", "INTERRUPTED_UNKNOWN"]),
  TEST: new Set(["CLEANUP", "TERMINAL", "INTERRUPTED_UNKNOWN"]),
  CLEANUP: new Set(["TERMINAL"]),
  TERMINAL: new Set(),
  INTERRUPTED_UNKNOWN: new Set(["NEEDS_ATTENTION"]),
  NEEDS_ATTENTION: new Set(),
});

// Data is intentionally small and enumerable.  Values are ids, digests,
// booleans are not accepted, and numbers are bounded.  A key allowlist keeps
// privacy failures fail-closed instead of trying to redact arbitrary input.
const DATA_KEYS = new Set([
  "reason_code", "failure_code", "cancel_code", "classification", "phase",
  "provider_state", "test_status", "result_status", "attempt", "count",
  "duration_ms", "bytes", "previous_seq", "digest", "evidence_digest",
]);
const ID_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isObject(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function hash(value) { return crypto.createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex"); }
function validRunId(value) { return typeof value === "string" && RUN_ID.test(value) && !value.includes("..") && !value.includes("/") && !value.includes("\\"); }
function validDigest(value) { return typeof value === "string" && DIGEST.test(value); }
function validateRunId(value) { if (!validRunId(value)) throw new Error("invalid recovery run id"); return value; }
function validateState(value) { if (typeof value !== "string" || !STATE_SET.has(value)) throw new Error("invalid recovery state"); return value; }
function validateTimestamp(value) { if (typeof value !== "string" || !TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) throw new Error("invalid recovery timestamp"); return value; }

function validateData(value, name = "data", depth = 0) {
  if (!isObject(value) || depth > 2) throw new Error(`${name} must be a bounded object`);
  const keys = Object.keys(value);
  if (keys.length > 16) throw new Error(`${name} has too many keys`);
  for (const key of keys) {
    if (!DATA_KEYS.has(key)) throw new Error(`${name} has unsupported key`);
    const item = value[key];
    if (typeof item === "string") {
      if (key.includes("digest")) { if (!validDigest(item)) throw new Error(`${name}.${key} must be a sha256 digest`); }
      else if (!ID_VALUE.test(item)) throw new Error(`${name}.${key} must be a logical id`);
    } else if (typeof item === "number") {
      if (!Number.isFinite(item) || item < 0 || item > Number.MAX_SAFE_INTEGER) throw new Error(`${name}.${key} must be bounded`);
      if ((key === "count" || key === "attempt" || key === "previous_seq" || key === "bytes") && !Number.isInteger(item)) throw new Error(`${name}.${key} must be an integer`);
    } else if (isObject(item)) validateData(item, `${name}.${key}`, depth + 1);
    else throw new Error(`${name}.${key} has unsupported value type`);
  }
  return value;
}

const EVENT_KEYS = Object.freeze(["schema", "version", "run_id", "seq", "state", "timestamp", "previous_hash", "event_hash", "data"]);
function exactKeys(value, keys, name) {
  if (!isObject(value)) throw new Error(`${name} must be an object`);
  const expected = [...keys].sort(); const actual = Object.keys(value).sort();
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) throw new Error(`${name} has unknown or missing keys`);
}

export function validateRecoveryEvent(event, { verifyHash = true } = {}) {
  exactKeys(event, EVENT_KEYS, "recovery event");
  if (event.schema !== RECOVERY_JOURNAL_SCHEMA || event.version !== RECOVERY_JOURNAL_VERSION) throw new Error("unsupported recovery event schema");
  validateRunId(event.run_id);
  if (!Number.isInteger(event.seq) || event.seq < 1 || event.seq > MAX_EVENTS) throw new Error("invalid recovery event sequence");
  validateState(event.state); validateTimestamp(event.timestamp);
  if (event.previous_hash !== null && !validDigest(event.previous_hash)) throw new Error("invalid previous event hash");
  if (!validDigest(event.event_hash)) throw new Error("invalid event hash");
  validateData(event.data);
  if (verifyHash) {
    const unsigned = { ...event }; delete unsigned.event_hash;
    if (hash(unsigned) !== event.event_hash) throw new Error("recovery event hash mismatch");
  }
  return event;
}

export function validateStateRoot(stateDir, { create = false } = {}) {
  if (typeof stateDir !== "string" || !stateDir.trim()) throw new Error("state directory is required");
  const target = path.resolve(stateDir);
  // Check each existing parent component.  A junction/reparse point or link
  // in the path would otherwise allow the caller to redirect journal writes.
  let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let component;
    try { component = fs.lstatSync(current); } catch {
      if (create) break;
      throw new Error("state directory path is unavailable");
    }
    if (component.isSymbolicLink() || (Number.isInteger(component.nlink) && component.nlink > 1)) throw new Error("state directory path contains a link");
  }
  if (create && !fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    return validateStateRoot(target);
  }
  let stat;
  try { stat = fs.lstatSync(target); } catch { throw new Error("state directory does not exist"); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (Number.isInteger(stat.nlink) && stat.nlink > 1)) throw new Error("state directory must be a private regular directory");
  return target;
}

function validateRunDirectory(runDir) {
  let stat;
  try { stat = fs.lstatSync(runDir); } catch { throw new Error("recovery run does not exist"); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (Number.isInteger(stat.nlink) && stat.nlink > 1)) throw new Error("recovery run directory is unsafe");
}

function eventFilename(seq) { return `${String(seq).padStart(8, "0")}.json`; }
function encodedEvent(event) {
  const text = `${canonical(event)}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_EVENT_BYTES) throw new Error("recovery event exceeds size bound");
  return Buffer.from(text, "utf8");
}

function readEventFiles(runDir, { maxEvents = MAX_EVENTS, maxBytes = MAX_SCAN_BYTES } = {}) {
  validateRunDirectory(runDir);
  let names;
  try { names = fs.readdirSync(runDir, { withFileTypes: true }); } catch { return { events: [], classification: "MALFORMED", error: "run directory unreadable" }; }
  const files = [];
  for (const entry of names) {
    // Temporary files are intentionally ignored.  Nonconforming persistent
    // names are ignored too; event sequence gaps are detected among .json.
    const match = EVENT_FILE.exec(entry.name);
    if (!match) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) return { events: [], classification: "REPARSE_POINT", error: "event entry is not a regular file" };
    const stat = fs.lstatSync(path.join(runDir, entry.name));
    if (stat.isSymbolicLink() || (Number.isInteger(stat.nlink) && stat.nlink > 1)) return { events: [], classification: "REPARSE_POINT", error: "event file is linked" };
    files.push({ name: entry.name, seq: Number(match[1]), size: stat.size });
  }
  files.sort((a, b) => a.seq - b.seq);
  if (files.length > maxEvents) return { events: [], classification: "BOUNDED_SCAN", error: "event count exceeds bound" };
  let bytes = 0; const events = [];
  for (const file of files) {
    bytes += file.size;
    if (file.size > MAX_EVENT_BYTES || bytes > maxBytes) return { events: [], classification: "BOUNDED_SCAN", error: "event bytes exceed bound" };
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(path.join(runDir, file.name), "utf8")); validateRecoveryEvent(parsed); } catch (error) { return { events, classification: "MALFORMED", error: String(error?.message || error), bytes }; }
    if (parsed.seq !== file.seq) return { events, classification: "HASH_GAP", error: "event filename sequence mismatch", bytes };
    const expected = events.length + 1;
    if (parsed.seq !== expected) return { events, classification: "HASH_GAP", error: `event sequence gap at ${expected}`, bytes };
    if (events.length && parsed.previous_hash !== events.at(-1).event_hash) return { events, classification: "HASH_GAP", error: "previous hash does not match", bytes };
    if (!events.length && parsed.previous_hash !== null) return { events, classification: "HASH_GAP", error: "first event has previous hash", bytes };
    events.push(parsed);
  }
  return { events, classification: "OK", bytes };
}

export class RecoveryJournal {
  constructor(stateDir, runId, { now = () => new Date() } = {}) {
    this.stateDir = validateStateRoot(stateDir);
    this.runId = validateRunId(runId);
    this.runDir = path.join(this.stateDir, this.runId);
    this.now = now;
    validateRunDirectory(this.runDir);
  }

  static create({ stateDir, runId = crypto.randomUUID(), now } = {}) {
    const root = validateStateRoot(stateDir, { create: true });
    const id = validateRunId(runId);
    const runDir = path.join(root, id);
    try { fs.mkdirSync(runDir, { mode: 0o700 }); } catch (error) { if (error?.code !== "EEXIST") throw error; validateRunDirectory(runDir); }
    const journal = new RecoveryJournal(root, id, { now });
    if (journal.readEvents().length === 0) journal.append("RUN_CREATED");
    return journal;
  }

  readEvents() {
    const result = readEventFiles(this.runDir);
    if (result.classification !== "OK") throw new Error(result.error || result.classification);
    return result.events;
  }

  append(state, data = {}) {
    validateState(state); validateData(data);
    const scanned = readEventFiles(this.runDir);
    if (scanned.classification !== "OK") throw new Error(scanned.error || scanned.classification);
    const events = scanned.events;
    const previous = events.at(-1) || null;
    if (previous && !TRANSITIONS[previous.state].has(state)) throw new Error(`invalid recovery transition ${previous.state}->${state}`);
    if (!previous && state !== "RUN_CREATED") throw new Error("recovery journal must start at RUN_CREATED");
    const seq = events.length + 1;
    const event = { schema: RECOVERY_JOURNAL_SCHEMA, version: RECOVERY_JOURNAL_VERSION, run_id: this.runId, seq, state, timestamp: this.now().toISOString(), previous_hash: previous?.event_hash || null, data: { ...data } };
    event.event_hash = hash(event);
    const filename = path.join(this.runDir, eventFilename(seq));
    let fd;
    try {
      fd = fs.openSync(filename, "wx", 0o600);
      const bytes = encodedEvent(event);
      let offset = 0;
      while (offset < bytes.length) { const written = fs.writeSync(fd, bytes, offset, bytes.length - offset); if (!Number.isInteger(written) || written <= 0) throw new Error("recovery event write made no progress"); offset += written; }
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
    } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* preserve original failure */ } } }
    return event;
  }

  verify() { return verifyRecoveryRun(this.runDir, this.runId); }
}

export function createRecoveryJournal(options) { return RecoveryJournal.create(options); }

export function verifyRecoveryRun(runDir, runId = path.basename(path.resolve(runDir))) {
  try { validateRunId(runId); const result = readEventFiles(path.resolve(runDir)); const events = result.events; const terminal = events.at(-1)?.state || null; const nonterminal = result.classification === "OK" && events.length > 0 && !TERMINAL_STATES.has(terminal); return { valid: result.classification === "OK" && !nonterminal, classification: nonterminal ? "NONTERMINAL" : result.classification, run_id: runId, event_count: events.length, bytes: result.bytes || 0, terminal_state: terminal, events }; }
  catch (error) { return { valid: false, classification: "REPARSE_POINT", run_id: runId, event_count: 0, bytes: 0, terminal_state: null, error: String(error?.message || error), events: [] }; }
}

export function scanRecoveryState(stateDir, { maxRuns = MAX_RUNS, maxEvents = MAX_EVENTS, maxBytes = MAX_SCAN_BYTES } = {}) {
  const root = validateStateRoot(stateDir);
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const candidates = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && validRunId(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
  const runs = []; let bytes = 0;
  if (candidates.length > maxRuns) return { schema: RECOVERY_JOURNAL_SCHEMA, version: RECOVERY_JOURNAL_VERSION, status: "BOUNDED_SCAN", run_count: candidates.length, runs: [] };
  for (const entry of candidates) {
    const dir = path.join(root, entry.name); let result;
    try { result = readEventFiles(dir, { maxEvents, maxBytes: Math.max(0, maxBytes - bytes) }); } catch (error) { result = { events: [], classification: "REPARSE_POINT", error: String(error?.message || error) }; }
    bytes += result.bytes || 0;
    const terminal = result.events.at(-1)?.state || null;
    const classification = result.classification === "OK" && result.events.length > 0 && !TERMINAL_STATES.has(terminal) ? "NONTERMINAL" : result.classification;
    runs.push({ run_id: entry.name, classification, event_count: result.events.length, bytes: result.bytes || 0, terminal_state: terminal, error: result.error || null });
    if (bytes > maxBytes) break;
  }
  return { schema: RECOVERY_JOURNAL_SCHEMA, version: RECOVERY_JOURNAL_VERSION, status: runs.some((run) => run.classification !== "OK") ? "ATTENTION" : "CLEAN", run_count: runs.length, bytes, runs };
}

export function recoveryStateTransitions() { return Object.fromEntries(Object.entries(TRANSITIONS).map(([state, next]) => [state, [...next]])); }
