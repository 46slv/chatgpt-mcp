import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export const CODEX_RUNTIME_BINDING_PROTOCOL = "devexec.codex-runtime-binding";
export const CODEX_RUNTIME_BINDING_SCHEMA_VERSION = 1;

export const CODEX_RUNTIME_ERRORS = Object.freeze({
  REQUIRED: "CODEX_RUNTIME_BINDING_REQUIRED",
  INVALID: "CODEX_RUNTIME_BINDING_INVALID",
  UNAVAILABLE: "CODEX_RUNTIME_UNAVAILABLE",
  DRIFT: "CODEX_RUNTIME_DRIFT",
  CAPABILITY_UNAVAILABLE: "CODEX_RUNTIME_CAPABILITY_UNAVAILABLE",
  PROBE_FAILED: "CODEX_RUNTIME_PROBE_FAILED",
  EXECUTION_FAILED: "CODEX_RUNTIME_EXECUTION_FAILED",
});

export const CODEX_RUNTIME_BINDING_REQUIRED = CODEX_RUNTIME_ERRORS.REQUIRED;
export const CODEX_RUNTIME_BINDING_INVALID = CODEX_RUNTIME_ERRORS.INVALID;
export const CODEX_RUNTIME_UNAVAILABLE = CODEX_RUNTIME_ERRORS.UNAVAILABLE;
export const CODEX_RUNTIME_DRIFT = CODEX_RUNTIME_ERRORS.DRIFT;
export const CODEX_RUNTIME_CAPABILITY_UNAVAILABLE = CODEX_RUNTIME_ERRORS.CAPABILITY_UNAVAILABLE;

const RUNTIME_FIELDS = Object.freeze([
  "protocol",
  "schema_version",
  "executable_path",
  "launch_args",
  "version",
  "capabilities",
  "fingerprint_files",
  "runtime_fingerprint",
  "required_capabilities",
  "provenance",
  "bound_at",
  "binding_id",
]);
const RUNTIME_HASH_FIELDS = Object.freeze(RUNTIME_FIELDS.filter((field) => field !== "binding_id"));
const CAPABILITY_NAMES = Object.freeze(["queue", "resume"]);
const SCRIPT_EXTENSIONS = new Set([".cmd", ".bat", ".ps1", ".sh", ".bash"]);
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/i;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export class CodexRuntimeBindingError extends Error {
  constructor(message, code = CODEX_RUNTIME_ERRORS.INVALID) {
    super(message);
    this.name = "CodexRuntimeBindingError";
    this.code = code;
  }
}

function fail(code, message, cause = undefined) {
  const error = new CodexRuntimeBindingError(message, code);
  if (cause !== undefined) error.cause = cause;
  throw error;
}

function requiredText(value, label, code = CODEX_RUNTIME_ERRORS.REQUIRED) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    fail(code, `${label} must be an exact non-empty string.`);
  }
  return value;
}

function digestBytes(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function digestJson(value) {
  return digestBytes(Buffer.from(JSON.stringify(value), "utf8"));
}

function assertDigest(value, label, code = CODEX_RUNTIME_ERRORS.INVALID) {
  if (typeof value !== "string" || !DIGEST_RE.test(value)) fail(code, `${label} must be a sha256 digest.`);
  return value;
}

function isAbsolutePath(value) {
  return typeof value === "string" && (path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value));
}

export function normalizeCodexRuntimePath(value, label = "executable_path", code = CODEX_RUNTIME_ERRORS.INVALID) {
  const text = requiredText(value, label, code);
  if (!isAbsolutePath(text)) fail(code, `${label} must be an absolute path; PATH lookup is not allowed.`);
  if (/^[A-Za-z]:[\\/]/.test(text)) return path.win32.normalize(text);
  return path.normalize(text);
}

export const normalizeRuntimePath = normalizeCodexRuntimePath;

function normalizeLaunchArgs(value, code = CODEX_RUNTIME_ERRORS.INVALID) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(code, "launch_args must be an array.");
  return value.map((entry, index) => requiredText(entry, `launch_args[${index}]`, code));
}

function normalizeVersion(value, code = CODEX_RUNTIME_ERRORS.INVALID) {
  return requiredText(value, "version", code);
}

function normalizeCapabilities(value, code = CODEX_RUNTIME_ERRORS.INVALID) {
  if (!isObject(value)) fail(code, "capabilities must be an object with boolean queue/resume fields.");
  const normalized = {};
  for (const name of CAPABILITY_NAMES) {
    if (value[name] !== undefined && typeof value[name] !== "boolean") fail(code, `capabilities.${name} must be boolean.`);
    normalized[name] = value[name] === true;
  }
  return normalized;
}

function normalizeRequiredCapabilities(value, capabilities, code = CODEX_RUNTIME_ERRORS.INVALID) {
  const requested = value === undefined ? [] : value;
  if (!Array.isArray(requested) || requested.some((entry) => !CAPABILITY_NAMES.includes(entry))) {
    fail(code, "required_capabilities must contain only queue/resume.");
  }
  const unique = [...new Set(requested)].sort();
  for (const name of unique) {
    if (capabilities[name] !== true) fail(CODEX_RUNTIME_ERRORS.CAPABILITY_UNAVAILABLE, `Required Codex capability is unavailable: ${name}.`);
  }
  return unique;
}

function normalizeProvenance(value, code = CODEX_RUNTIME_ERRORS.INVALID) {
  return requiredText(firstDefined(value, "explicit-runtime"), "provenance", code);
}

function extensionOf(value) {
  return path.win32.extname(value).toLowerCase() || path.extname(value).toLowerCase();
}

function isScriptLauncher(value) {
  return SCRIPT_EXTENSIONS.has(extensionOf(value));
}

function realPathOf(value, realpath = fs.realpathSync.native || fs.realpathSync) {
  return normalizeCodexRuntimePath(realpath(value), "realpath", CODEX_RUNTIME_ERRORS.UNAVAILABLE);
}

function captureFileEvidence(filePath, { stat = fs.statSync, readFile = fs.readFileSync, realpath = fs.realpathSync.native || fs.realpathSync } = {}) {
  const normalizedPath = normalizeCodexRuntimePath(filePath, "fingerprint_files.path", CODEX_RUNTIME_ERRORS.UNAVAILABLE);
  let metadata;
  let bytes;
  let resolved;
  try {
    metadata = stat(normalizedPath);
    if (!metadata || metadata.isFile?.() !== true) fail(CODEX_RUNTIME_ERRORS.UNAVAILABLE, `Runtime fingerprint path is not a regular file: ${normalizedPath}.`);
    bytes = readFile(normalizedPath);
    resolved = realPathOf(normalizedPath, realpath);
  } catch (error) {
    if (error instanceof CodexRuntimeBindingError) throw error;
    fail(CODEX_RUNTIME_ERRORS.UNAVAILABLE, `Runtime fingerprint path cannot be read: ${normalizedPath}.`, error);
  }
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return {
    path: normalizedPath,
    realpath: resolved,
    size: buffer.length,
    sha256: digestBytes(buffer),
  };
}

function normalizeFingerprintEntry(entry, { capture = false, stat, readFile, realpath } = {}) {
  const source = typeof entry === "string" ? { path: entry } : entry;
  if (!isObject(source)) fail(CODEX_RUNTIME_ERRORS.INVALID, "fingerprint_files entries must be paths or evidence objects.");
  const normalizedPath = normalizeCodexRuntimePath(source.path, "fingerprint_files.path", CODEX_RUNTIME_ERRORS.INVALID);
  const hasEvidence = source.sha256 !== undefined || source.hash !== undefined || source.size !== undefined || source.realpath !== undefined;
  if (capture || !hasEvidence) return captureFileEvidence(normalizedPath, { stat, readFile, realpath });

  const sha = assertDigest(firstDefined(source.sha256, source.hash), "fingerprint_files.sha256");
  if (!Number.isInteger(source.size) || source.size < 0) fail(CODEX_RUNTIME_ERRORS.INVALID, "fingerprint_files.size must be a non-negative integer.");
  const resolved = source.realpath === undefined || source.realpath === null
    ? null
    : normalizeCodexRuntimePath(source.realpath, "fingerprint_files.realpath", CODEX_RUNTIME_ERRORS.INVALID);
  return { path: normalizedPath, realpath: resolved, size: source.size, sha256: sha };
}

function normalizeFingerprintFiles(value, executablePath, options = {}) {
  const source = value === undefined ? [executablePath] : value;
  if (!Array.isArray(source) || source.length === 0) fail(CODEX_RUNTIME_ERRORS.INVALID, "fingerprint_files must be a non-empty array.");
  const files = source.map((entry) => normalizeFingerprintEntry(entry, options));
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (new Set(sorted.map((entry) => entry.path)).size !== sorted.length) fail(CODEX_RUNTIME_ERRORS.INVALID, "fingerprint_files must not contain duplicates.");
  if (!sorted.some((entry) => entry.path === executablePath)) fail(CODEX_RUNTIME_ERRORS.INVALID, "fingerprint_files must include executable_path.");
  if (isScriptLauncher(executablePath) && sorted.length < 2) {
    fail(CODEX_RUNTIME_ERRORS.INVALID, "Script/shim launchers require fingerprint evidence for the underlying implementation.");
  }
  return sorted;
}

function runtimeFingerprintPayload(fields) {
  return {
    protocol: CODEX_RUNTIME_BINDING_PROTOCOL,
    schema_version: CODEX_RUNTIME_BINDING_SCHEMA_VERSION,
    executable_path: fields.executable_path,
    launch_args: fields.launch_args,
    version: fields.version,
    capabilities: {
      queue: fields.capabilities.queue === true,
      resume: fields.capabilities.resume === true,
    },
    fingerprint_files: fields.fingerprint_files.map((entry) => ({
      path: entry.path,
      realpath: entry.realpath,
      size: entry.size,
      sha256: entry.sha256,
    })),
  };
}

function computeRuntimeFingerprint(fields) {
  return digestJson(runtimeFingerprintPayload(fields));
}

function bindingHashPayload(fields) {
  const payload = {};
  for (const field of RUNTIME_HASH_FIELDS) {
    if (field === "protocol") payload[field] = CODEX_RUNTIME_BINDING_PROTOCOL;
    else if (field === "schema_version") payload[field] = CODEX_RUNTIME_BINDING_SCHEMA_VERSION;
    else payload[field] = fields[field];
  }
  return payload;
}

function computeBindingId(fields) {
  return digestJson(bindingHashPayload(fields));
}

function freezeBinding(fields) {
  return deepFreeze({
    protocol: CODEX_RUNTIME_BINDING_PROTOCOL,
    schema_version: CODEX_RUNTIME_BINDING_SCHEMA_VERSION,
    executable_path: fields.executable_path,
    launch_args: [...fields.launch_args],
    version: fields.version,
    capabilities: { ...fields.capabilities },
    fingerprint_files: fields.fingerprint_files.map((entry) => ({ ...entry })),
    runtime_fingerprint: fields.runtime_fingerprint,
    required_capabilities: [...fields.required_capabilities],
    provenance: fields.provenance,
    bound_at: fields.bound_at,
    binding_id: fields.binding_id,
  });
}

function normalizeCreateFields(input) {
  if (!isObject(input)) fail(CODEX_RUNTIME_ERRORS.REQUIRED, "Codex runtime binding input is required.");
  const executablePath = normalizeCodexRuntimePath(
    firstDefined(input.executable_path, input.runtime_path, input.executable, input.path),
    "executable_path",
    CODEX_RUNTIME_ERRORS.REQUIRED,
  );
  const launchArgs = normalizeLaunchArgs(firstDefined(input.launch_args, input.argv_prefix));
  const version = normalizeVersion(firstDefined(input.version, input.codex_version));
  const capabilities = normalizeCapabilities(input.capabilities);
  const requiredCapabilities = normalizeRequiredCapabilities(
    firstDefined(input.required_capabilities, input.requiredCapabilities, input.require_queue === true ? ["queue"] : undefined),
    capabilities,
  );
  const fingerprintFiles = normalizeFingerprintFiles(
    firstDefined(input.fingerprint_files, input.fingerprint_paths, input.launch_files),
    executablePath,
    { capture: false },
  );
  const boundAt = firstDefined(input.bound_at, input.created_at) === undefined
    ? new Date().toISOString()
    : requiredText(firstDefined(input.bound_at, input.created_at), "bound_at");
  const provenance = normalizeProvenance(firstDefined(input.provenance, input.source));
  const fields = {
    executable_path: executablePath,
    launch_args: launchArgs,
    version,
    capabilities,
    fingerprint_files: fingerprintFiles,
    required_capabilities: requiredCapabilities,
    provenance,
    bound_at: boundAt,
  };
  const computed = computeRuntimeFingerprint(fields);
  const supplied = firstDefined(input.runtime_fingerprint, input.fingerprint);
  if (supplied !== undefined && assertDigest(supplied, "runtime_fingerprint") !== computed) {
    fail(CODEX_RUNTIME_ERRORS.INVALID, "runtime_fingerprint does not match the immutable runtime evidence.");
  }
  fields.runtime_fingerprint = computed;
  fields.binding_id = computeBindingId(fields);
  if (input.binding_id !== undefined && input.binding_id !== fields.binding_id) {
    fail(CODEX_RUNTIME_ERRORS.INVALID, "binding_id does not match the parent-owned Codex runtime binding.");
  }
  return fields;
}

/** Create an immutable runtime binding from explicit, already-selected launch evidence. */
export function createCodexRuntimeBinding(input = {}) {
  return freezeBinding(normalizeCreateFields(input));
}

export const bindCodexRuntime = createCodexRuntimeBinding;
export const createRuntimeBinding = createCodexRuntimeBinding;

function canonicalizeStoredBinding(value) {
  if (!isObject(value)) fail(CODEX_RUNTIME_ERRORS.INVALID, "Codex runtime binding must be an object.");
  for (const field of RUNTIME_FIELDS) {
    if (!hasOwn(value, field)) fail(CODEX_RUNTIME_ERRORS.INVALID, `Codex runtime binding field is missing: ${field}.`);
  }
  for (const field of Object.keys(value)) {
    if (!RUNTIME_FIELDS.includes(field)) fail(CODEX_RUNTIME_ERRORS.INVALID, `Unknown Codex runtime binding field: ${field}.`);
  }
  if (value.protocol !== CODEX_RUNTIME_BINDING_PROTOCOL || value.schema_version !== CODEX_RUNTIME_BINDING_SCHEMA_VERSION) {
    fail(CODEX_RUNTIME_ERRORS.INVALID, "Unsupported Codex runtime binding protocol or schema_version.");
  }
  const executablePath = normalizeCodexRuntimePath(value.executable_path, "executable_path");
  const launchArgs = normalizeLaunchArgs(value.launch_args);
  const version = normalizeVersion(value.version);
  const capabilities = normalizeCapabilities(value.capabilities);
  const requiredCapabilities = normalizeRequiredCapabilities(value.required_capabilities, capabilities);
  const fingerprintFiles = normalizeFingerprintFiles(value.fingerprint_files, executablePath, { capture: false });
  const provenance = normalizeProvenance(value.provenance);
  const boundAt = requiredText(value.bound_at, "bound_at");
  const fields = {
    executable_path: executablePath,
    launch_args: launchArgs,
    version,
    capabilities,
    fingerprint_files: fingerprintFiles,
    required_capabilities: requiredCapabilities,
    provenance,
    bound_at: boundAt,
  };
  const expectedFingerprint = computeRuntimeFingerprint(fields);
  if (value.runtime_fingerprint !== expectedFingerprint) fail(CODEX_RUNTIME_ERRORS.INVALID, "runtime_fingerprint does not match the canonical runtime evidence.");
  fields.runtime_fingerprint = expectedFingerprint;
  const expectedBindingId = computeBindingId(fields);
  if (value.binding_id !== expectedBindingId) fail(CODEX_RUNTIME_ERRORS.INVALID, "binding_id does not match the canonical Codex runtime binding.");
  fields.binding_id = expectedBindingId;
  return fields;
}

/** Validate persisted parent state and return an immutable canonical copy. */
export function validateCodexRuntimeBinding(value) {
  if (value === null || value === undefined) fail(CODEX_RUNTIME_ERRORS.REQUIRED, "Codex runtime binding is required.");
  return freezeBinding(canonicalizeStoredBinding(value));
}

export const validateRuntimeBinding = validateCodexRuntimeBinding;

export function codexRuntimeBindingHashPayload(value) {
  const binding = validateCodexRuntimeBinding(value);
  return deepFreeze(bindingHashPayload(binding));
}

export const runtimeBindingHashPayload = codexRuntimeBindingHashPayload;

export function codexRuntimeFingerprint(value) {
  const binding = validateCodexRuntimeBinding(value);
  return binding.runtime_fingerprint;
}

export const runtimeFingerprint = codexRuntimeFingerprint;

function currentFileEvidence(stored, { stat = fs.statSync, readFile = fs.readFileSync, realpath = fs.realpathSync.native || fs.realpathSync } = {}) {
  return captureFileEvidence(stored.path, { stat, readFile, realpath });
}

function sameRuntimePath(left, right) {
  if (process.platform === "win32") return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

function normalizeObservedCapabilities(value) {
  return normalizeCapabilities(value, CODEX_RUNTIME_ERRORS.DRIFT);
}

/** Re-read bound files and optional observed probe data; never resolves another runtime. */
export function verifyCodexRuntimeBinding(value, { observed = null, stat, readFile, realpath } = {}) {
  const binding = validateCodexRuntimeBinding(value);
  const currentFiles = binding.fingerprint_files.map((stored) => {
    let current;
    try {
      current = currentFileEvidence(stored, { stat, readFile, realpath });
    } catch (error) {
      if (error?.code === CODEX_RUNTIME_ERRORS.UNAVAILABLE) throw error;
      fail(CODEX_RUNTIME_ERRORS.UNAVAILABLE, `Bound Codex runtime file is unavailable: ${stored.path}.`, error);
    }
    if (stored.size !== current.size || stored.sha256.toLowerCase() !== current.sha256.toLowerCase()) {
      fail(CODEX_RUNTIME_ERRORS.DRIFT, `Bound Codex runtime file drifted: ${stored.path}.`);
    }
    if (stored.realpath !== null && !sameRuntimePath(stored.realpath, current.realpath)) {
      fail(CODEX_RUNTIME_ERRORS.DRIFT, `Bound Codex runtime target changed: ${stored.path}.`);
    }
    return current;
  });

  let version = binding.version;
  let capabilities = binding.capabilities;
  if (observed !== null && observed !== undefined) {
    if (!isObject(observed)) fail(CODEX_RUNTIME_ERRORS.DRIFT, "Observed Codex runtime evidence is invalid.");
    const observedPath = firstDefined(observed.executable_path, observed.runtime_path, observed.executable, observed.path);
    if (observedPath !== undefined) {
      const normalizedObservedPath = normalizeCodexRuntimePath(observedPath, "observed.executable_path", CODEX_RUNTIME_ERRORS.DRIFT);
      if (!sameRuntimePath(normalizedObservedPath, binding.executable_path)) {
        fail(CODEX_RUNTIME_ERRORS.DRIFT, "Observed Codex executable differs from the bound runtime.");
      }
    }
    const observedLaunchArgs = firstDefined(observed.launch_args, observed.argv_prefix);
    if (observedLaunchArgs !== undefined) {
      const normalizedObservedArgs = normalizeLaunchArgs(observedLaunchArgs, CODEX_RUNTIME_ERRORS.DRIFT);
      if (JSON.stringify(normalizedObservedArgs) !== JSON.stringify(binding.launch_args)) {
        fail(CODEX_RUNTIME_ERRORS.DRIFT, "Observed Codex launch arguments differ from the bound runtime.");
      }
    }
    version = normalizeVersion(observed.version, CODEX_RUNTIME_ERRORS.DRIFT);
    capabilities = normalizeObservedCapabilities(observed.capabilities);
    if (version !== binding.version || capabilities.queue !== binding.capabilities.queue || capabilities.resume !== binding.capabilities.resume) {
      fail(CODEX_RUNTIME_ERRORS.DRIFT, "Observed Codex runtime version/capabilities drifted from the bound runtime.");
    }
    if (observed.runtime_fingerprint !== undefined && observed.runtime_fingerprint !== binding.runtime_fingerprint) {
      fail(CODEX_RUNTIME_ERRORS.DRIFT, "Observed Codex runtime fingerprint differs from the bound runtime.");
    }
    if (observed.fingerprint_files !== undefined) {
      const observedFiles = normalizeFingerprintFiles(observed.fingerprint_files, binding.executable_path, { capture: false });
      if (JSON.stringify(observedFiles) !== JSON.stringify(currentFiles)) {
        fail(CODEX_RUNTIME_ERRORS.DRIFT, "Observed Codex runtime fingerprint files differ from the bound runtime.");
      }
    }
  }
  const currentFingerprint = computeRuntimeFingerprint({
    executable_path: binding.executable_path,
    launch_args: binding.launch_args,
    version,
    capabilities,
    fingerprint_files: currentFiles,
  });
  if (currentFingerprint !== binding.runtime_fingerprint) fail(CODEX_RUNTIME_ERRORS.DRIFT, "Bound Codex runtime fingerprint drifted.");
  for (const name of binding.required_capabilities) {
    if (capabilities[name] !== true) fail(CODEX_RUNTIME_ERRORS.CAPABILITY_UNAVAILABLE, `Required Codex capability is unavailable: ${name}.`);
  }
  return deepFreeze({
    status: "VERIFIED",
    binding_id: binding.binding_id,
    executable_path: binding.executable_path,
    version: binding.version,
    capabilities: { ...binding.capabilities },
    runtime_fingerprint: binding.runtime_fingerprint,
  });
}

export const verifyRuntimeBinding = verifyCodexRuntimeBinding;

function exitCodeOf(result) {
  if (!isObject(result)) return 0;
  const value = firstDefined(result.exitCode, result.code, result.status);
  return value === undefined || value === null ? 0 : Number(value);
}

function outputOf(result) {
  if (!isObject(result)) return "";
  return String(firstDefined(result.stdout, result.output, ""));
}

/** Parse only explicit command-list entries from a Codex help response. */
export function parseCodexRuntimeCapabilities(helpText) {
  const lines = String(helpText || "").split(/\r?\n/).map((line) => line.trimEnd());
  const hasCommand = (name) => lines.some((line) => new RegExp(`^\\s{2,}${name}(?:\\s{2,}|$)`).test(line));
  return deepFreeze({ queue: hasCommand("queue"), resume: hasCommand("resume") });
}

export const parseRuntimeCapabilities = parseCodexRuntimeCapabilities;

function parseVersionOutput(value) {
  const line = String(value || "").split(/\r?\n/).map((entry) => entry.trim()).find(Boolean);
  if (!line) fail(CODEX_RUNTIME_ERRORS.PROBE_FAILED, "Codex --version returned no version evidence.");
  return line;
}

function normalizedProbeCandidate(input) {
  if (!isObject(input)) fail(CODEX_RUNTIME_ERRORS.REQUIRED, "Codex runtime probe candidate is required.");
  const executablePath = normalizeCodexRuntimePath(firstDefined(input.executable_path, input.runtime_path, input.executable, input.path), "executable_path", CODEX_RUNTIME_ERRORS.REQUIRED);
  const launchArgs = normalizeLaunchArgs(firstDefined(input.launch_args, input.argv_prefix));
  return { executable_path: executablePath, launch_args: launchArgs };
}

/** Default bounded process adapter for exact runtime probes; it never performs PATH lookup. */
export function invokeCodexRuntimeProcess({ command, args = [], cwd, timeoutMs = 30000 } = {}) {
  const executablePath = normalizeCodexRuntimePath(command, "command", CODEX_RUNTIME_ERRORS.REQUIRED);
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, args, { cwd, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new CodexRuntimeBindingError("Codex runtime probe timed out.", CODEX_RUNTIME_ERRORS.PROBE_FAILED));
    }, Math.max(1, Number(timeoutMs) || 30000));
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new CodexRuntimeBindingError("Codex runtime process could not start.", CODEX_RUNTIME_ERRORS.UNAVAILABLE));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: Number.isInteger(code) ? code : -1, stdout, stderr });
    });
  });
}

/** Probe one explicitly supplied launch vector and return non-secret runtime evidence. */
export async function probeCodexRuntime({
  executable_path,
  runtime_path,
  executable,
  path: candidatePath,
  launch_args,
  argv_prefix,
  fingerprint_files,
  fingerprint_paths,
  launch_files,
  cwd = process.cwd(),
  invoke = invokeCodexRuntimeProcess,
} = {}) {
  const candidate = normalizedProbeCandidate({ executable_path, runtime_path, executable, path: candidatePath, launch_args, argv_prefix });
  let versionResult;
  let helpResult;
  try {
    versionResult = await invoke({ command: candidate.executable_path, args: [...candidate.launch_args, "--version"], cwd, purpose: "runtime-version" });
    helpResult = await invoke({ command: candidate.executable_path, args: [...candidate.launch_args, "--help"], cwd, purpose: "runtime-help" });
  } catch (error) {
    if (error?.code === CODEX_RUNTIME_ERRORS.UNAVAILABLE || error?.code === CODEX_RUNTIME_ERRORS.PROBE_FAILED) throw error;
    fail(CODEX_RUNTIME_ERRORS.PROBE_FAILED, "Codex runtime probe failed.", error);
  }
  if (exitCodeOf(versionResult) !== 0 || exitCodeOf(helpResult) !== 0) {
    fail(CODEX_RUNTIME_ERRORS.PROBE_FAILED, "Codex runtime probe returned a non-zero exit code.");
  }
  const version = parseVersionOutput(outputOf(versionResult));
  const capabilities = parseCodexRuntimeCapabilities(outputOf(helpResult));
  const files = normalizeFingerprintFiles(
    firstDefined(fingerprint_files, fingerprint_paths, launch_files),
    candidate.executable_path,
    { capture: true },
  );
  const evidence = {
    executable_path: candidate.executable_path,
    launch_args: candidate.launch_args,
    version,
    capabilities,
    fingerprint_files: files,
  };
  return deepFreeze({
    ...evidence,
    runtime_fingerprint: computeRuntimeFingerprint(evidence),
  });
}

export const probeCodexRuntimeCandidate = probeCodexRuntime;

/** Probe explicitly enumerated candidates for diagnostics; never chooses a winner or falls back. */
export async function probeCodexRuntimeCandidates(candidates, options = {}) {
  if (!Array.isArray(candidates)) fail(CODEX_RUNTIME_ERRORS.REQUIRED, "Codex runtime candidates must be an array.");
  return deepFreeze(await Promise.all(candidates.map(async (candidate) => {
    try {
      return { status: "PROBED", ...(await probeCodexRuntime({ ...options, ...candidate })) };
    } catch (error) {
      return {
        status: "REJECTED",
        executable_path: candidate?.executable_path || candidate?.runtime_path || candidate?.path || null,
        code: error?.code || CODEX_RUNTIME_ERRORS.PROBE_FAILED,
      };
    }
  })));
}
