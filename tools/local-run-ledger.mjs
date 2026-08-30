import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Parent-owned, privacy-bounded observability for a single local worker run.
 * This deliberately has no dependency on the Task/Result contracts and never
 * serializes arbitrary provider or worker payloads.
 */
export const LOCAL_RUN_RECORD_SCHEMA = "devexec.local-run-record/v1";
export const LOCAL_RUN_RECORD_VERSION = 1;
const MAX_ID = 200;
const MAX_DIGEST = 64;
const MAX_SELECTION_ID = 128;
const MAX_PATHS = 256;
const MAX_SUMMARY_FILES = 10000;

const ENUMS = Object.freeze({
  status: new Set(["DONE", "BLOCKED", "FAILED", "CANCELLED", "UNKNOWN"]),
  availability: new Set(["AVAILABLE", "UNAVAILABLE", "NOT_COLLECTED"]),
  cleanup: new Set(["NOT_REQUIRED", "COMPLETED", "PARTIAL", "FAILED", "UNKNOWN"]),
  ownership: new Set(["NONE", "ADAPTER", "PARENT", "UNKNOWN"]),
});

function boundedId(value, fallback = "unknown", max = MAX_ID) {
  const text = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return text.slice(0, max);
}

function enumValue(value, allowed, fallback = "UNKNOWN") {
  return typeof value === "string" && allowed.has(value) ? value : fallback;
}

function finiteNumber(value, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = false } = {}) {
  if (!Number.isFinite(value) || value < min || value > max) return null;
  return integer ? Math.trunc(value) : value;
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

export function sha256Digest(value) {
  return digest(typeof value === "string" ? value : canonical(value));
}

/** A stable contract identity that omits goal, paths, cwd, repo and worktree. */
export function contractFingerprint(task) {
  const safe = {
    version: task?.version ?? null,
    task_id: task?.task_id ?? null,
    base_commit: task?.base_commit ?? null,
    classification: task?.classification ?? null,
    constraints: Array.isArray(task?.constraints) ? task.constraints : [],
    test_command_digest: Array.isArray(task?.test_command) ? sha256Digest(task.test_command) : null,
    timeout: task?.timeout ?? null,
    max_tool_calls: task?.max_tool_calls ?? null,
    output_limit: task?.output_limit ?? null,
  };
  return sha256Digest(safe);
}

function boundedDigest(value) {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value) ? value.toLowerCase() : null;
}

function boundedLogical(value) {
  return boundedId(value, "unknown", MAX_SELECTION_ID).replace(/[^A-Za-z0-9._:/-]/g, "_");
}

function modelLogical(value) {
  const text = typeof value === "string" && value.trim() ? value.trim() : "unknown";
  return boundedLogical(path.basename(text.replaceAll("\\", "/")) || "unknown");
}

function metric(value) { return finiteNumber(value, { max: 3_600_000 }); }

function metricOrNull(value) { return value == null ? null : metric(Number(value)); }

function availability(value, known) {
  if (known === false) return "UNAVAILABLE";
  if (known === true) return "AVAILABLE";
  return enumValue(value, ENUMS.availability, "NOT_COLLECTED");
}

function observation(value = {}) {
  const clean = value && typeof value === "object" ? value : {};
  const count = finiteNumber(clean.count, { min: 0, max: MAX_PATHS, integer: true });
  const paths = Array.isArray(clean.paths) ? clean.paths.slice(0, MAX_PATHS).map((p) => String(p).replaceAll("\\", "/")).filter((p) => p && !path.isAbsolute(p) && !/^[A-Za-z]:\//.test(p)) : [];
  const pathDigest = boundedDigest(clean.digest) || (paths.length ? sha256Digest(paths) : null);
  return { count: count ?? paths.length, digest: pathDigest };
}

function lifecycle(input = {}) {
  const names = ["preflight", "gpu_gate", "start", "ready", "inference", "test", "postflight", "cleanup"];
  const output = {};
  for (const name of names) output[name] = metricOrNull(input[name]);
  return output;
}

function resource(input = {}) {
  const known = input?.availability;
  const available = input?.available === true || input?.available === false ? input.available : (known === "AVAILABLE" ? true : known === "UNAVAILABLE" ? false : null);
  return {
    before: metricOrNull(input.before),
    peak: metricOrNull(input.peak),
    after: metricOrNull(input.after),
    availability: availability(known, input.available),
    available,
  };
}

function harnessMetrics(input = {}) {
  const result = {};
  for (const key of ["wall_time_ms", "first_tool_latency_ms", "tool_calls", "prompt_tokens", "completion_tokens", "total_tokens"]) {
    const value = finiteNumber(input[key], { min: 0, max: key === "tool_calls" ? 1000 : 3_600_000, integer: key === "tool_calls" || key.endsWith("tokens") });
    result[key] = value;
  }
  return result;
}

function normalizeRecord(input = {}) {
  const baseline = input.baseline || {};
  const outcome = input.outcome || {};
  const evidence = input.evidence || {};
  const record = {
    schema: LOCAL_RUN_RECORD_SCHEMA,
    version: LOCAL_RUN_RECORD_VERSION,
    run_id: boundedId(input.run_id),
    selection: {
      runtime: boundedLogical(input.selection?.runtime || "local"),
      provider: boundedLogical(input.selection?.provider || "unknown"),
      harness: boundedLogical(input.selection?.harness || "minimal-harness"),
      model: modelLogical(input.selection?.model || "unknown"),
    },
    contract_fingerprint: boundedDigest(input.contract_fingerprint),
    base_commit: boundedDigest(input.base_commit),
    baseline: {
      clean: input.baseline?.clean === true ? true : input.baseline?.clean === false ? false : null,
      modified: finiteNumber(baseline.modified, { min: 0, max: MAX_PATHS, integer: true }),
      added: finiteNumber(baseline.added, { min: 0, max: MAX_PATHS, integer: true }),
      deleted: finiteNumber(baseline.deleted, { min: 0, max: MAX_PATHS, integer: true }),
      untracked: finiteNumber(baseline.untracked, { min: 0, max: MAX_PATHS, integer: true }),
      digest: boundedDigest(baseline.digest),
    },
    lifecycle_ms: lifecycle(input.lifecycle_ms),
    harness: harnessMetrics(input.harness),
    resources: { ram_mb: resource(input.resources?.ram_mb), vram_mb: resource(input.resources?.vram_mb) },
    outcome: {
      status: enumValue(outcome.status, ENUMS.status),
      changed: observation(outcome.changed),
      diff: observation(outcome.diff),
      tests: { status: boundedLogical(outcome.tests?.status || "NOT_RUN"), count: finiteNumber(outcome.tests?.count, { min: 0, max: MAX_PATHS, integer: true }), digest: boundedDigest(outcome.tests?.digest) },
      base_drift: outcome.base_drift === true ? true : outcome.base_drift === false ? false : null,
      commit_detected: outcome.commit_detected === true ? true : outcome.commit_detected === false ? false : null,
      evidence_digest: boundedDigest(evidence.digest),
    },
    ownership: {
      provider: enumValue(input.ownership?.provider, ENUMS.ownership),
      cleanup: enumValue(input.ownership?.cleanup, ENUMS.cleanup),
      cleanup_verified: input.ownership?.cleanup_verified === true ? true : input.ownership?.cleanup_verified === false ? false : null,
    },
  };
  return record;
}

export function createLocalRunRecord(input = {}) {
  const runId = boundedId(input.run_id || crypto.randomUUID());
  return normalizeRecord({ ...input, run_id: runId });
}

export function validateLocalRunRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("local run record must be an object");
  if (record.schema !== LOCAL_RUN_RECORD_SCHEMA || record.version !== LOCAL_RUN_RECORD_VERSION) throw new Error("unsupported local run record schema");
  if (!record.run_id || typeof record.run_id !== "string" || record.run_id.length > MAX_ID) throw new Error("invalid local run id");
  if (!record.selection || typeof record.selection !== "object") throw new Error("selection is required");
  if (record.contract_fingerprint !== null && !boundedDigest(record.contract_fingerprint)) throw new Error("invalid contract fingerprint");
  if (record.base_commit !== null && !boundedDigest(record.base_commit)) throw new Error("invalid base commit");
  return record;
}

export function createLifecycleRecorder(now = () => Date.now()) {
  const starts = new Map();
  const elapsed = {};
  return Object.freeze({
    mark(event) {
      const match = String(event || "").match(/^(preflight|gpu_gate|start|ready|inference|test|postflight|cleanup)_(start|end)$/);
      if (!match) return;
      const [, name, edge] = match;
      if (edge === "start") starts.set(name, now());
      else if (starts.has(name)) { elapsed[name] = Math.max(0, now() - starts.get(name)); starts.delete(name); }
    },
    snapshot() { return { ...elapsed }; },
  });
}

export function writeLocalRunRecordAtomic(directory, record, { fsImpl = fs } = {}) {
  const value = validateLocalRunRecord(record);
  const dir = path.resolve(String(directory));
  fsImpl.mkdirSync(dir, { recursive: true });
  const encoded = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > 64 * 1024) throw new Error("local run record exceeds evidence limit");
  const target = path.join(dir, `${value.run_id}.json`);
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  fsImpl.writeFileSync(temporary, encoded, { encoding: "utf8", flag: "wx" });
  try {
    if (fsImpl.existsSync(target)) throw new Error("local run record already exists");
    fsImpl.renameSync(temporary, target);
  } catch (error) { try { fsImpl.rmSync(temporary, { force: true }); } catch { /* best effort */ } throw error; }
  return target;
}

function percentile(values, p) {
  if (!values.length) return null;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * p) - 1));
  return values.slice().sort((a, b) => a - b)[index];
}

export function summarizeLocalRunRecords(directory, { readFile = fs.readFileSync, readdir = fs.readdirSync } = {}) {
  const dir = path.resolve(String(directory));
  let names = [];
  try { names = readdir(dir).filter((name) => name.endsWith(".json")).sort().slice(0, MAX_SUMMARY_FILES); } catch { names = []; }
  const records = [];
  for (const name of names) {
    try {
      const record = validateLocalRunRecord(JSON.parse(readFile(path.join(dir, name), "utf8")));
      records.push(record);
    } catch { /* ignore unrelated/corrupt files; summary is read-only */ }
  }
  const durations = records.map((r) => r.harness?.wall_time_ms).filter((v) => Number.isFinite(v));
  const done = records.filter((r) => r.outcome?.status === "DONE").length;
  return { schema: LOCAL_RUN_RECORD_SCHEMA, count: records.length, success: done, success_rate: records.length ? done / records.length : null, wall_time_ms: { p50: percentile(durations, 0.5), p95: percentile(durations, 0.95) } };
}
