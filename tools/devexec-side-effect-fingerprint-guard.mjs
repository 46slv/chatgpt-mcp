import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const SIDE_EFFECT_GUARD_PROTOCOL = "devexec.side-effect-fingerprint-guard";
export const SIDE_EFFECT_GUARD_SCHEMA_VERSION = 1;

const MAX_RECORD_BYTES = 64 * 1024;
const MAX_TEXT = 1024;
const HEX64 = /^[a-f0-9]{64}$/;
const HEX32 = /^[a-f0-9]{32}$/;
const FINAL_STATUSES = new Set(["SUCCEEDED", "FAILED", "AMBIGUOUS", "STOPPED"]);
const RECORD_KEYS = Object.freeze([
  "protocol", "schema_version", "fingerprint", "equivalence_key", "action", "status",
  "reason_code", "claim_hash", "created_at", "updated_at", "precondition_identity",
  "post_identity", "attempt_count", "side_effect_count", "diagnostic", "record_hash",
]);
const ACTION_KEYS = Object.freeze([
  "surface", "action_type", "target", "immutable_input", "expected_precondition",
  "prior_attempt_id", "control_identity", "distinct_reason",
]);

export class SideEffectGuardError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = "SideEffectGuardError";
    this.code = code;
  }
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : canonical(value), "utf8").digest("hex");
}

function exactKeys(value, keys, label) {
  if (!isObject(value)) throw new SideEffectGuardError("SIDE_EFFECT_GUARD_INVALID", `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new SideEffectGuardError("SIDE_EFFECT_GUARD_INVALID", `${label} has unknown or missing keys`);
  }
}

function bounded(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new SideEffectGuardError("SIDE_EFFECT_GUARD_INVALID", `${label} is invalid`);
  }
  return value;
}

function normalizeAction(input) {
  exactKeys(input, ACTION_KEYS, "action");
  const action = {
    surface: bounded(input.surface, "surface"),
    action_type: bounded(input.action_type, "action_type"),
    target: bounded(input.target, "target"),
    immutable_input: bounded(input.immutable_input, "immutable_input"),
    expected_precondition: bounded(input.expected_precondition, "expected_precondition"),
    prior_attempt_id: bounded(input.prior_attempt_id, "prior_attempt_id", { nullable: true }),
    control_identity: bounded(input.control_identity, "control_identity"),
    distinct_reason: bounded(input.distinct_reason, "distinct_reason", { nullable: true }),
  };
  return action;
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink?.() || stat.isReparsePoint?.()) {
    throw new SideEffectGuardError("SIDE_EFFECT_GUARD_UNSAFE_STATE", "guard state directory is unsafe");
  }
}

function writeAllAndSync(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (!Number.isInteger(written) || written <= 0) {
      throw new SideEffectGuardError("SIDE_EFFECT_GUARD_IO", "guard write made no progress");
    }
    offset += written;
  }
  fs.fsyncSync(fd);
}

function recordWithoutHash(record) {
  const copy = { ...record };
  delete copy.record_hash;
  return copy;
}

function seal(record) {
  const output = { ...record, record_hash: null };
  output.record_hash = sha256(recordWithoutHash(output));
  return output;
}

function validateRecord(record, expectedFingerprint = null) {
  exactKeys(record, RECORD_KEYS, "guard record");
  if (record.protocol !== SIDE_EFFECT_GUARD_PROTOCOL || record.schema_version !== SIDE_EFFECT_GUARD_SCHEMA_VERSION) {
    throw new SideEffectGuardError("SIDE_EFFECT_GUARD_CORRUPT", "guard record schema is unsupported");
  }
  if (!HEX64.test(record.fingerprint) || !HEX64.test(record.equivalence_key) || !HEX64.test(record.claim_hash) || !HEX64.test(record.record_hash)) {
    throw new SideEffectGuardError("SIDE_EFFECT_GUARD_CORRUPT", "guard record digest is invalid");
  }
  if (expectedFingerprint !== null && record.fingerprint !== expectedFingerprint) {
    throw new SideEffectGuardError("SIDE_EFFECT_GUARD_CORRUPT", "guard record fingerprint does not match its path");
  }
  normalizeAction(record.action);
  if (!["PREPARED", "IN_FLIGHT", ...FINAL_STATUSES].includes(record.status)) {
    throw new SideEffectGuardError("SIDE_EFFECT_GUARD_CORRUPT", "guard record status is invalid");
  }
  if (record.reason_code !== null) bounded(record.reason_code, "reason_code");
  if (record.precondition_identity !== null) bounded(record.precondition_identity, "precondition_identity");
  if (record.post_identity !== null) bounded(record.post_identity, "post_identity");
  if (record.diagnostic !== null) bounded(record.diagnostic, "diagnostic");
  if (!Number.isInteger(record.attempt_count) || record.attempt_count < 0 || record.attempt_count > 1) {
    throw new SideEffectGuardError("SIDE_EFFECT_GUARD_CORRUPT", "guard record attempt_count is invalid");
  }
  if (!Number.isInteger(record.side_effect_count) || record.side_effect_count < 0 || record.side_effect_count > 1) {
    throw new SideEffectGuardError("SIDE_EFFECT_GUARD_CORRUPT", "guard record side_effect_count is invalid");
  }
  if (!Number.isFinite(Date.parse(record.created_at)) || !Number.isFinite(Date.parse(record.updated_at))) {
    throw new SideEffectGuardError("SIDE_EFFECT_GUARD_CORRUPT", "guard record timestamp is invalid");
  }
  if (sha256(recordWithoutHash(record)) !== record.record_hash) {
    throw new SideEffectGuardError("SIDE_EFFECT_GUARD_CORRUPT", "guard record hash mismatch");
  }
  return record;
}

function readRecord(file, expectedFingerprint) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink?.() || stat.isReparsePoint?.() || (Number.isInteger(stat.nlink) && stat.nlink !== 1)) {
    throw new SideEffectGuardError("SIDE_EFFECT_GUARD_CORRUPT", "guard record is not a private regular file");
  }
  if (stat.size <= 0 || stat.size > MAX_RECORD_BYTES) {
    throw new SideEffectGuardError("SIDE_EFFECT_GUARD_CORRUPT", "guard record size is invalid");
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new SideEffectGuardError("SIDE_EFFECT_GUARD_CORRUPT", "guard record is unreadable", { cause: error });
  }
  return validateRecord(parsed, expectedFingerprint);
}

function writeExclusiveRecord(file, record) {
  let fd;
  try {
    fd = fs.openSync(file, "wx", 0o600);
    writeAllAndSync(fd, Buffer.from(`${JSON.stringify(record)}\n`, "utf8"));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function replaceRecord(file, record, claimToken) {
  const fingerprint = record.fingerprint;
  const current = readRecord(file, fingerprint);
  if (current.claim_hash !== sha256(claimToken)) {
    throw new SideEffectGuardError("SIDE_EFFECT_GUARD_CLAIM_MISMATCH", "guard claim token does not own this action fingerprint");
  }
  const temp = path.join(path.dirname(file), `.${fingerprint}.${crypto.randomBytes(16).toString("hex")}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    writeAllAndSync(fd, Buffer.from(`${JSON.stringify(record)}\n`, "utf8"));
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } catch (error) {
    try { if (fd !== undefined) fs.closeSync(fd); } catch { /* preserve original */ }
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* preserve original */ }
    if (error instanceof SideEffectGuardError) throw error;
    throw new SideEffectGuardError("SIDE_EFFECT_GUARD_IO", "failed to persist guard transition", { cause: error });
  }
  return readRecord(file, fingerprint);
}

function pathsFor(stateDir, fingerprint) {
  if (typeof stateDir !== "string" || !stateDir.trim()) {
    throw new SideEffectGuardError("SIDE_EFFECT_GUARD_STATE_DIR_REQUIRED", "stateDir is required");
  }
  const root = path.join(path.resolve(stateDir), "side-effect-fingerprints-v1");
  return { root, file: path.join(root, `${fingerprint}.json`) };
}

function equivalenceKey(action) {
  return sha256({
    surface: action.surface,
    action_type: action.action_type,
    target: action.target,
    immutable_input: action.immutable_input,
  });
}

function listEquivalent(root, key) {
  if (!fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
  if (entries.length > 4096) throw new SideEffectGuardError("SIDE_EFFECT_GUARD_STATE_LIMIT", "too many guard records");
  const output = [];
  for (const entry of entries) {
    const fingerprint = entry.slice(0, 64);
    const record = readRecord(path.join(root, entry), fingerprint);
    if (record.equivalence_key === key) output.push(record);
  }
  return output;
}

export function deriveSideEffectFingerprint(actionInput) {
  const action = normalizeAction(actionInput);
  return {
    action,
    fingerprint: sha256(action),
    equivalence_key: equivalenceKey(action),
  };
}

export function inspectSideEffectFingerprint({ stateDir, action } = {}) {
  const derived = deriveSideEffectFingerprint(action);
  const { root, file } = pathsFor(stateDir, derived.fingerprint);
  if (!fs.existsSync(file)) return null;
  return { ...readRecord(file, derived.fingerprint) };
}

function outcomeFromExisting(record) {
  if (record.status === "SUCCEEDED") return { decision: "DUPLICATE", reason_code: "SIDE_EFFECT_ALREADY_SUCCEEDED", record };
  if (record.status === "STOPPED" && record.reason_code === "FROZEN") return { decision: "STOP", reason_code: "FROZEN", record };
  if (record.status === "FAILED") return { decision: "STOP", reason_code: "RETRY_FORBIDDEN", record };
  return { decision: "STOP", reason_code: "AMBIGUOUS_PRIOR_ATTEMPT", record };
}

function update(file, current, claimToken, patch, now) {
  const next = seal({
    ...current,
    ...patch,
    updated_at: now().toISOString(),
  });
  return replaceRecord(file, next, claimToken);
}

function validateControlState(value) {
  if (!isObject(value) || !["ALLOW", "FROZEN", "STOP"].includes(value.decision)) {
    throw new SideEffectGuardError("SIDE_EFFECT_GUARD_INVALID_CONTROL", "control state must classify ALLOW, FROZEN, or STOP");
  }
  return { identity: bounded(value.identity, "control identity"), decision: value.decision };
}

function validateReadback(value) {
  if (!isObject(value) || !["MATCH", "ABSENT", "MISMATCH", "UNKNOWN"].includes(value.state)) {
    throw new SideEffectGuardError("SIDE_EFFECT_GUARD_INVALID_READBACK", "readback must classify MATCH, ABSENT, MISMATCH, or UNKNOWN");
  }
  const identity = value.identity === null ? null : bounded(value.identity, "readback.identity", { nullable: true });
  return { state: value.state, identity };
}

export async function runSideEffectWithFingerprintGuard({
  stateDir,
  action: actionInput,
  readControlIdentity,
  readPrecondition,
  execute,
  readBack,
  now = () => new Date(),
} = {}) {
  if (typeof readControlIdentity !== "function" || typeof readPrecondition !== "function" || typeof execute !== "function" || typeof readBack !== "function") {
    throw new SideEffectGuardError("SIDE_EFFECT_GUARD_INVALID", "control, precondition, execute, and readBack callbacks are required");
  }
  const derived = deriveSideEffectFingerprint(actionInput);
  const { action, fingerprint, equivalence_key } = derived;
  const { root, file } = pathsFor(stateDir, fingerprint);

  let observedControl;
  try {
    observedControl = validateControlState(await readControlIdentity());
  } catch (error) {
    if (error instanceof SideEffectGuardError) throw error;
    throw new SideEffectGuardError("SIDE_EFFECT_GUARD_CONTROL_READ_FAILED", "control state could not be fresh-read", { cause: error });
  }

  ensurePrivateDirectory(root);
  const equivalent = listEquivalent(root, equivalence_key);
  if (equivalent.length > 0) return outcomeFromExisting(equivalent.at(-1));

  const claimToken = crypto.randomBytes(16).toString("hex");
  if (!HEX32.test(claimToken)) throw new Error("unreachable claim token");
  const createdAt = now().toISOString();
  let record = seal({
    protocol: SIDE_EFFECT_GUARD_PROTOCOL,
    schema_version: SIDE_EFFECT_GUARD_SCHEMA_VERSION,
    fingerprint,
    equivalence_key,
    action,
    status: "PREPARED",
    reason_code: null,
    claim_hash: sha256(claimToken),
    created_at: createdAt,
    updated_at: createdAt,
    precondition_identity: null,
    post_identity: null,
    attempt_count: 0,
    side_effect_count: 0,
    diagnostic: null,
  });

  try {
    writeExclusiveRecord(file, record);
  } catch (error) {
    if (error?.code === "EEXIST") return outcomeFromExisting(readRecord(file, fingerprint));
    if (error instanceof SideEffectGuardError) throw error;
    throw new SideEffectGuardError("SIDE_EFFECT_GUARD_FINGERPRINT_RECORD_FAILED", "pre-action fingerprint could not be recorded", { cause: error });
  }
  record = readRecord(file, fingerprint);

  if (observedControl.identity !== action.control_identity) {
    record = update(file, record, claimToken, { status: "STOPPED", reason_code: "STALE_CONTROL", diagnostic: `observed=${observedControl.identity}` }, now);
    return { decision: "STOP", reason_code: "STALE_CONTROL", record };
  }
  if (observedControl.decision !== "ALLOW") {
    const reason = observedControl.decision === "FROZEN" ? "FROZEN" : "CONTROL_STOP";
    record = update(file, record, claimToken, { status: "STOPPED", reason_code: reason }, now);
    return { decision: "STOP", reason_code: reason, record };
  }

  let precondition;
  try {
    precondition = bounded(await readPrecondition(), "precondition identity");
  } catch (error) {
    record = update(file, record, claimToken, { status: "STOPPED", reason_code: "PRECONDITION_READ_FAILED", diagnostic: String(error?.message || error).slice(0, MAX_TEXT) }, now);
    return { decision: "STOP", reason_code: "PRECONDITION_READ_FAILED", record };
  }
  if (precondition !== action.expected_precondition) {
    record = update(file, record, claimToken, { status: "STOPPED", reason_code: "PRECONDITION_MISMATCH", precondition_identity: precondition }, now);
    return { decision: "STOP", reason_code: "PRECONDITION_MISMATCH", record };
  }

  record = update(file, record, claimToken, {
    status: "IN_FLIGHT",
    reason_code: null,
    precondition_identity: precondition,
    attempt_count: 1,
  }, now);

  let execution;
  let thrown = null;
  try {
    execution = await execute();
  } catch (error) {
    thrown = error;
  }
  // The side-effect call boundary was crossed exactly once. Even a transport
  // exception is therefore non-retryable until readback proves the outcome.
  record = update(file, record, claimToken, { side_effect_count: 1 }, now);

  let readback;
  try {
    readback = validateReadback(await readBack({ execution, error: thrown }));
  } catch (error) {
    record = update(file, record, claimToken, {
      status: "AMBIGUOUS",
      reason_code: "READBACK_FAILED",
      diagnostic: String(error?.message || error).slice(0, MAX_TEXT),
    }, now);
    return { decision: "STOP", reason_code: "READBACK_FAILED", record };
  }

  if (readback.state === "MATCH") {
    record = update(file, record, claimToken, {
      status: "SUCCEEDED",
      reason_code: null,
      post_identity: readback.identity,
      diagnostic: thrown ? String(thrown?.message || thrown).slice(0, MAX_TEXT) : null,
    }, now);
    return { decision: "PASS", reason_code: null, record, execution };
  }
  if (readback.state === "ABSENT") {
    record = update(file, record, claimToken, {
      status: "FAILED",
      reason_code: "NO_EFFECT_PROVEN",
      post_identity: readback.identity,
      diagnostic: thrown ? String(thrown?.message || thrown).slice(0, MAX_TEXT) : null,
    }, now);
    return { decision: "STOP", reason_code: "NO_EFFECT_PROVEN", record };
  }
  if (readback.state === "MISMATCH") {
    record = update(file, record, claimToken, {
      status: "AMBIGUOUS",
      reason_code: "POSTCONDITION_MISMATCH",
      post_identity: readback.identity,
    }, now);
    return { decision: "STOP", reason_code: "POSTCONDITION_MISMATCH", record };
  }

  record = update(file, record, claimToken, {
    status: "AMBIGUOUS",
    reason_code: "OUTCOME_UNKNOWN",
    post_identity: readback.identity,
    diagnostic: thrown ? String(thrown?.message || thrown).slice(0, MAX_TEXT) : null,
  }, now);
  return { decision: "STOP", reason_code: "OUTCOME_UNKNOWN", record };
}
