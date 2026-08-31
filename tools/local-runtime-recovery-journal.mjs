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
 * run as malformed.  Temporary and non-event entries are evidence too: the
 * scanner reports them as NEEDS_ATTENTION rather than silently filtering them.
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
function validateTimestamp(value) {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) throw new Error("invalid recovery timestamp");
  const parsed = Date.parse(value);
  // Date.parse normalises impossible dates (for example February 31).  A
  // round-trip through toISOString makes the wire format genuinely strict.
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error("invalid recovery timestamp");
  return value;
}

function normalizeBound(value, fallback, maximum) {
  // Invalid caller supplied bounds must never turn a scan into an unbounded
  // traversal.  Zero remains a useful explicit bound for tests and callers
  // wishing to inspect only the directory envelope.
  if (!Number.isSafeInteger(value) || value < 0) return fallback;
  return Math.min(value, maximum);
}
function safeScanBounds({ maxRuns = MAX_RUNS, maxEvents = MAX_EVENTS, maxBytes = MAX_SCAN_BYTES } = {}) {
  return {
    maxRuns: normalizeBound(maxRuns, MAX_RUNS, MAX_RUNS),
    maxEvents: normalizeBound(maxEvents, MAX_EVENTS, MAX_EVENTS),
    maxBytes: normalizeBound(maxBytes, MAX_SCAN_BYTES, MAX_SCAN_BYTES),
  };
}

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
    if (component.isSymbolicLink() || component.isReparsePoint?.() || (Number.isInteger(component.nlink) && component.nlink > 1)) throw new Error("state directory path contains a link");
  }
  if (create && !fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    return validateStateRoot(target);
  }
  let stat;
  try { stat = fs.lstatSync(target); } catch { throw new Error("state directory does not exist"); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.isReparsePoint?.() || (Number.isInteger(stat.nlink) && stat.nlink > 1)) throw new Error("state directory must be a private regular directory");
  return target;
}

function validateRunDirectory(runDir) {
  let stat;
  try { stat = fs.lstatSync(runDir); } catch { throw new Error("recovery run does not exist"); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.isReparsePoint?.() || (Number.isInteger(stat.nlink) && stat.nlink > 1)) throw new Error("recovery run directory is unsafe");
  return stat;
}

function pathComponentsArePrivate(target) {
  let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let component;
    try { component = fs.lstatSync(current); } catch { throw new Error("recovery path is unavailable"); }
    if (component.isSymbolicLink?.() || component.isReparsePoint?.()) throw new Error("recovery path contains a link");
  }
}

function directoryIdentity(stat) {
  if (!stat) return null;
  const identity = {};
  // Directory mtime/ctime/size change when an event is appended, so they are
  // deliberately not identity evidence.  dev/ino are stable where Node can
  // expose a file index. birthtime is a weaker Windows fallback, but still
  // detects ordinary same-path directory replacement without rejecting a
  // legitimate child creation.
  if (Number.isFinite(stat.dev) && Number.isFinite(stat.ino) && stat.ino !== 0) {
    identity.dev = stat.dev;
    identity.ino = stat.ino;
  } else if (Number.isFinite(stat.birthtimeMs)) {
    identity.birthtimeMs = stat.birthtimeMs;
  }
  return identity;
}

function identityEqual(a, b) {
  if (!a || !b) return false;
  const aKeys = Object.keys(a).sort(); const bKeys = Object.keys(b).sort();
  return aKeys.length === bKeys.length && aKeys.every((key, index) => key === bKeys[index] && a[key] === b[key]);
}

function captureDirectoryAnchor(directory) {
  const lexical = path.resolve(directory);
  pathComponentsArePrivate(lexical);
  const canonicalPath = fs.realpathSync.native(lexical);
  if (canonicalPath !== lexical) throw new Error("recovery path canonicalization changed");
  let stat = fs.lstatSync(lexical);
  if (!stat.isDirectory() || stat.isSymbolicLink?.() || stat.isReparsePoint?.()) throw new Error("recovery path must be a private directory");
  let descriptorIdentity = null;
  let fd;
  try {
    fd = fs.openSync(lexical, fs.constants.O_RDONLY);
    descriptorIdentity = directoryIdentity(fs.fstatSync(fd));
  } catch {
    // Windows may reject opening a directory.  The lstat/realpath identity
    // remains useful and is rechecked before and after every operation.
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore close failure */ } }
  }
  return { lexical, canonicalPath, identity: directoryIdentity(stat), descriptorIdentity };
}

function revalidateDirectoryAnchor(anchor, label = "recovery directory") {
  if (!anchor) return;
  try {
    pathComponentsArePrivate(anchor.lexical);
    const canonicalPath = fs.realpathSync.native(anchor.lexical);
    if (canonicalPath !== anchor.canonicalPath) throw new Error(`${label} canonical path changed`);
    const stat = fs.lstatSync(anchor.lexical);
    if (!stat.isDirectory() || stat.isSymbolicLink?.() || stat.isReparsePoint?.()) throw new Error(`${label} is redirected`);
    if (!identityEqual(anchor.identity, directoryIdentity(stat))) throw new Error(`${label} identity changed`);
    if (anchor.descriptorIdentity && !identityEqual(anchor.descriptorIdentity, directoryIdentity(stat))) throw new Error(`${label} descriptor identity changed`);
  } catch (error) {
    throw new Error(`${label} changed or is unavailable`);
  }
}

function readDirectoryBounded(directory, limit, anchor, label) {
  revalidateDirectoryAnchor(anchor, label);
  let handle;
  const entries = [];
  let truncated = false;
  try {
    handle = fs.opendirSync(directory);
    for (;;) {
      const entry = handle.readSync();
      if (entry === null) break;
      if (entries.length >= limit) { truncated = true; break; }
      entries.push(entry);
    }
  } finally {
    if (handle !== undefined) { try { handle.closeSync(); } catch { /* preserve read failure */ } }
  }
  revalidateDirectoryAnchor(anchor, label);
  return { entries, truncated };
}

function sameIdentity(a, b) {
  if (!a || !b) return false;
  // dev/ino are stable on POSIX; on Windows the file index fields may be
  // unavailable, so size/mtime/nlink still provide a fail-closed race check.
  const identity = (key) => a[key] !== undefined && b[key] !== undefined ? a[key] === b[key] : true;
  return identity("dev") && identity("ino") && identity("size") && identity("mtimeMs") && identity("nlink");
}

function readFileNoFollow(filePath, before) {
  let fd;
  try {
    let flags = fs.constants.O_RDONLY;
    if (fs.constants.O_NOFOLLOW) flags |= fs.constants.O_NOFOLLOW;
    fd = fs.openSync(filePath, flags);
    const opened = fs.fstatSync(fd);
    if (opened.isSymbolicLink?.() || (Number.isInteger(opened.nlink) && opened.nlink > 1) || !sameIdentity(before, opened)) throw new Error("event file changed while reading");
    const text = fs.readFileSync(fd, "utf8");
    const after = fs.fstatSync(fd);
    if (!sameIdentity(opened, after)) throw new Error("event file changed while reading");
    return text;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* preserve read failure */ } }
  }
}

function eventFilename(seq) { return `${String(seq).padStart(8, "0")}.json`; }
function encodedEvent(event) {
  const text = `${canonical(event)}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_EVENT_BYTES) throw new Error("recovery event exceeds size bound");
  return Buffer.from(text, "utf8");
}

function readEventFiles(runDir, { maxEvents = MAX_EVENTS, maxBytes = MAX_SCAN_BYTES, expectedRunId = null, rootAnchor = null, runAnchor = null } = {}) {
  const lexicalRunDir = path.resolve(runDir);
  let root = rootAnchor;
  let run = runAnchor;
  try {
    root ||= captureDirectoryAnchor(path.dirname(lexicalRunDir));
    run ||= captureDirectoryAnchor(lexicalRunDir);
    revalidateDirectoryAnchor(root, "recovery state directory");
    revalidateDirectoryAnchor(run, "recovery run directory");
    validateRunDirectory(lexicalRunDir);
  } catch { return { events: [], classification: "REPARSE_POINT", error: "recovery run directory is unsafe" }; }
  let listing;
  try { listing = readDirectoryBounded(lexicalRunDir, maxEvents + 1, run, "recovery run directory"); }
  catch { return { events: [], classification: "MALFORMED", error: "run directory unreadable" }; }
  if (listing.truncated || listing.entries.length > maxEvents) return { events: [], classification: "BOUNDED_SCAN", error: "event count exceeds bound" };
  const names = listing.entries;
  const files = [];
  for (const entry of names) {
    // Every entry is inspected.  The scanner turns non-event names into a
    // NEEDS_ATTENTION result; this reader uses a stable code for the same
    // evidence so verification never silently ignores it.
    const match = EVENT_FILE.exec(entry.name);
    if (!match) return { events: [], classification: "UNEXPECTED_ENTRY", error: "run directory contains a non-event entry" };
    if (!entry.isFile() || entry.isSymbolicLink()) return { events: [], classification: "REPARSE_POINT", error: "event entry is not a regular file" };
    const eventPath = path.join(lexicalRunDir, entry.name);
    let stat;
    try { stat = fs.lstatSync(eventPath); } catch { return { events: [], classification: "TOCTOU", error: "event entry unavailable" }; }
    if (stat.isSymbolicLink() || (Number.isInteger(stat.nlink) && stat.nlink > 1)) return { events: [], classification: "REPARSE_POINT", error: "event file is linked" };
    files.push({ name: entry.name, seq: Number(match[1]), size: stat.size });
  }
  try {
    revalidateDirectoryAnchor(root, "recovery state directory");
    revalidateDirectoryAnchor(run, "recovery run directory");
  } catch { return { events: [], classification: "TOCTOU", error: "run directory changed while reading" }; }
  files.sort((a, b) => a.seq - b.seq);
  let bytes = 0; const events = [];
  for (const file of files) {
    bytes += file.size;
    if (file.size > MAX_EVENT_BYTES || bytes > maxBytes) return { events: [], classification: "BOUNDED_SCAN", error: "event bytes exceed bound" };
    let parsed;
    try {
      const eventPath = path.join(lexicalRunDir, file.name);
      const before = fs.lstatSync(eventPath);
      if (!before.isFile() || before.isSymbolicLink() || (Number.isInteger(before.nlink) && before.nlink > 1)) throw new Error("event entry is not a regular file");
      parsed = JSON.parse(readFileNoFollow(eventPath, before));
      validateRecoveryEvent(parsed);
      if (expectedRunId !== null && parsed.run_id !== expectedRunId) throw new Error("recovery event run id mismatch");
      const after = fs.lstatSync(eventPath);
      if (!sameIdentity(before, after)) throw new Error("event file changed while reading");
    } catch (error) { return { events, classification: "MALFORMED", error: String(error?.message || error), bytes }; }
    if (parsed.seq !== file.seq) return { events, classification: "HASH_GAP", error: "event filename sequence mismatch", bytes };
    const expected = events.length + 1;
    if (parsed.seq !== expected) return { events, classification: "HASH_GAP", error: `event sequence gap at ${expected}`, bytes };
    if (events.length && parsed.previous_hash !== events.at(-1).event_hash) return { events, classification: "HASH_GAP", error: "previous hash does not match", bytes };
    if (!events.length && parsed.previous_hash !== null) return { events, classification: "HASH_GAP", error: "first event has previous hash", bytes };
    if (!events.length && parsed.state !== "RUN_CREATED") return { events, classification: "INVALID_TRANSITION", error: "recovery journal must start at RUN_CREATED", bytes };
    if (events.length) {
      const previous = events.at(-1);
      if (!TRANSITIONS[previous.state]?.has(parsed.state)) return { events, classification: "INVALID_TRANSITION", error: "invalid recovery transition", bytes };
      if (Date.parse(parsed.timestamp) < Date.parse(previous.timestamp)) return { events, classification: "TIMESTAMP_ORDER", error: "recovery event timestamp moved backwards", bytes };
    }
    events.push(parsed);
  }
  try {
    revalidateDirectoryAnchor(root, "recovery state directory");
    revalidateDirectoryAnchor(run, "recovery run directory");
  } catch { return { events, classification: "TOCTOU", error: "run directory changed while reading", bytes }; }
  return { events, classification: "OK", bytes };
}

export class RecoveryJournal {
  constructor(stateDir, runId, { now = () => new Date() } = {}) {
    this.stateDir = validateStateRoot(stateDir);
    this.runId = validateRunId(runId);
    this.runDir = path.join(this.stateDir, this.runId);
    this.now = now;
    this.rootAnchor = captureDirectoryAnchor(this.stateDir);
    this.runAnchor = captureDirectoryAnchor(this.runDir);
    validateRunDirectory(this.runDir);
  }

  static create({ stateDir, runId = crypto.randomUUID(), now } = {}) {
    const root = validateStateRoot(stateDir, { create: true });
    const rootAnchor = captureDirectoryAnchor(root);
    const id = validateRunId(runId);
    const runDir = path.join(root, id);
    try { fs.mkdirSync(runDir, { mode: 0o700 }); } catch (error) { if (error?.code !== "EEXIST") throw error; validateRunDirectory(runDir); }
    revalidateDirectoryAnchor(rootAnchor, "recovery state directory");
    const journal = new RecoveryJournal(root, id, { now });
    if (journal.readEvents().length === 0) journal.append("RUN_CREATED");
    return journal;
  }

  readEvents() {
    const result = readEventFiles(this.runDir, {
      expectedRunId: this.runId, rootAnchor: this.rootAnchor, runAnchor: this.runAnchor,
    });
    if (result.classification !== "OK") throw new Error(result.error || result.classification);
    return result.events;
  }

  append(state, data = {}) {
    validateState(state); validateData(data);
    const scanned = readEventFiles(this.runDir, {
      expectedRunId: this.runId, rootAnchor: this.rootAnchor, runAnchor: this.runAnchor,
    });
    if (scanned.classification !== "OK") throw new Error(scanned.error || scanned.classification);
    const events = scanned.events;
    const previous = events.at(-1) || null;
    if (previous && !TRANSITIONS[previous.state].has(state)) throw new Error(`invalid recovery transition ${previous.state}->${state}`);
    if (!previous && state !== "RUN_CREATED") throw new Error("recovery journal must start at RUN_CREATED");
    const seq = events.length + 1;
    let timestamp;
    try { timestamp = this.now().toISOString(); } catch { throw new Error("invalid recovery timestamp"); }
    validateTimestamp(timestamp);
    if (previous && Date.parse(timestamp) < Date.parse(previous.timestamp)) throw new Error("recovery event timestamp moved backwards");
    const event = { schema: RECOVERY_JOURNAL_SCHEMA, version: RECOVERY_JOURNAL_VERSION, run_id: this.runId, seq, state, timestamp, previous_hash: previous?.event_hash || null, data: { ...data } };
    event.event_hash = hash(event);
    const filename = path.join(this.runDir, eventFilename(seq));
    let fd;
    try {
      revalidateDirectoryAnchor(this.rootAnchor, "recovery state directory");
      revalidateDirectoryAnchor(this.runAnchor, "recovery run directory");
      fd = fs.openSync(filename, "wx", 0o600);
      const bytes = encodedEvent(event);
      let offset = 0;
      while (offset < bytes.length) { const written = fs.writeSync(fd, bytes, offset, bytes.length - offset); if (!Number.isInteger(written) || written <= 0) throw new Error("recovery event write made no progress"); offset += written; }
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      revalidateDirectoryAnchor(this.rootAnchor, "recovery state directory");
      revalidateDirectoryAnchor(this.runAnchor, "recovery run directory");
    } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* preserve original failure */ } } }
    return event;
  }

  verify() { return verifyRecoveryRun(this.runDir, this.runId); }
}

export function createRecoveryJournal(options) { return RecoveryJournal.create(options); }

export function verifyRecoveryRun(runDir, runId = path.basename(path.resolve(runDir))) {
  try { validateRunId(runId); const result = readEventFiles(path.resolve(runDir), { expectedRunId: runId }); const events = result.events; const terminal = events.at(-1)?.state || null; const nonterminal = result.classification === "OK" && events.length > 0 && !TERMINAL_STATES.has(terminal); return { valid: result.classification === "OK" && !nonterminal, classification: nonterminal ? "NONTERMINAL" : result.classification, run_id: runId, event_count: events.length, bytes: result.bytes || 0, terminal_state: terminal, events }; }
  catch (error) { return { valid: false, classification: "REPARSE_POINT", run_id: runId, event_count: 0, bytes: 0, terminal_state: null, error: String(error?.message || error), events: [] }; }
}

export function scanRecoveryState(stateDir, { maxRuns = MAX_RUNS, maxEvents = MAX_EVENTS, maxBytes = MAX_SCAN_BYTES } = {}) {
  const root = validateStateRoot(stateDir);
  const bounds = safeScanBounds({ maxRuns, maxEvents, maxBytes });
  let rootAnchor; let listing;
  try {
    rootAnchor = captureDirectoryAnchor(root);
    listing = readDirectoryBounded(root, bounds.maxRuns + 1, rootAnchor, "recovery state directory");
  }
  catch { return { schema: RECOVERY_JOURNAL_SCHEMA, version: RECOVERY_JOURNAL_VERSION, status: "NEEDS_ATTENTION", run_count: 0, bytes: 0, runs: [], reason_code: "STATE_DIRECTORY_UNREADABLE" }; }
  const entries = listing.entries.sort((a, b) => a.name.localeCompare(b.name));
  const runs = []; let bytes = 0;
  const boundedByRuns = listing.truncated || entries.length > bounds.maxRuns;
  // `opendirSync` is consumed only through this bounded window.  We never
  // materialize an unbounded root or run directory just to report attention.
  for (const entry of entries.slice(0, bounds.maxRuns)) {
    const name = entry.name;
    const safeId = validRunId(name);
    const entryDigest = hash(name);
    const attention = (reason_code, extra = {}) => ({
      ...(safeId ? { run_id: name } : {}), entry_digest: entryDigest,
      classification: "NEEDS_ATTENTION", reason_code, event_count: 0,
      bytes: 0, terminal_state: null, error: null, ...extra,
    });
    if (!safeId) { runs.push(attention("UNSAFE_RUN_ID")); continue; }
    const dir = path.join(root, name);
    let stat;
    try { stat = fs.lstatSync(dir); }
    catch { runs.push(attention("RUN_ENTRY_UNAVAILABLE")); continue; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (Number.isInteger(stat.nlink) && stat.nlink > 1)) {
      runs.push(attention(stat.isSymbolicLink() || stat.nlink > 1 ? "RUN_ENTRY_LINKED" : "RUN_ENTRY_NOT_DIRECTORY")); continue;
    }
    let runAnchor; let childListing;
    try {
      runAnchor = captureDirectoryAnchor(dir);
      childListing = readDirectoryBounded(dir, bounds.maxEvents + 1, runAnchor, "recovery run directory");
    }
    catch { runs.push(attention("RUN_DIRECTORY_UNREADABLE")); continue; }
    const children = childListing.entries;
    if (childListing.truncated || children.length > bounds.maxEvents) {
      runs.push({ ...attention("BOUNDED_SCAN"), classification: "BOUNDED_SCAN" }); continue;
    }
    if (children.length === 0) { runs.push(attention("EMPTY_RUN_DIRECTORY")); continue; }
    const nonEvents = children.filter((child) => !EVENT_FILE.test(child.name));
    if (nonEvents.length && nonEvents.every((child) => /^owned\.tmp(?:[-.]|$)/i.test(child.name) || /\.tmp(?:[-.]|$)/i.test(child.name))) {
      runs.push(attention("ONLY_TEMP_ENTRIES", { entry_count: children.length })); continue;
    }
    let result;
    try {
      result = readEventFiles(dir, {
        maxEvents: bounds.maxEvents, maxBytes: Math.max(0, bounds.maxBytes - bytes), expectedRunId: name,
        rootAnchor, runAnchor,
      });
    }
    catch { result = { events: [], classification: "NEEDS_ATTENTION", error: null }; }
    bytes += result.bytes || 0;
    const terminal = result.events.at(-1)?.state || null;
    const rawClassification = result.classification === "OK" && result.events.length > 0 && !TERMINAL_STATES.has(terminal) ? "NONTERMINAL" : result.classification === "OK" && result.events.length === 0 ? "NEEDS_ATTENTION" : result.classification;
    const classification = rawClassification === "OK" || rawClassification === "NONTERMINAL" || rawClassification === "BOUNDED_SCAN" ? rawClassification : "NEEDS_ATTENTION";
    runs.push({ run_id: name, entry_digest: entryDigest, classification, reason_code: classification === "OK" || classification === "NONTERMINAL" ? null : rawClassification, event_count: result.events.length, bytes: result.bytes || 0, terminal_state: terminal, error: null });
    if (bytes >= bounds.maxBytes) break;
  }
  try { revalidateDirectoryAnchor(rootAnchor, "recovery state directory"); }
  catch { return { schema: RECOVERY_JOURNAL_SCHEMA, version: RECOVERY_JOURNAL_VERSION, status: "NEEDS_ATTENTION", run_count: entries.length, scanned_count: runs.length, bytes, runs, reason_code: "STATE_DIRECTORY_CHANGED" }; }
  const status = boundedByRuns || bytes >= bounds.maxBytes || runs.some((run) => run.classification === "BOUNDED_SCAN") ? "BOUNDED_SCAN" : runs.some((run) => run.classification !== "OK") ? "ATTENTION" : "CLEAN";
  return { schema: RECOVERY_JOURNAL_SCHEMA, version: RECOVERY_JOURNAL_VERSION, status, run_count: entries.length, scanned_count: runs.length, bytes, runs };
}

export function recoveryStateTransitions() { return Object.fromEntries(Object.entries(TRANSITIONS).map(([state, next]) => [state, [...next]])); }
