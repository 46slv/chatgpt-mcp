import { execFileSync, spawn } from "node:child_process";
import { runMinimalHarness } from "./minimal-harness-inference.mjs";

export const FREETOKEN_CONTROL_URL = "http://127.0.0.1:1900";
export const FREETOKEN_SERVE_URL = "http://127.0.0.1:1919";
export const FREETOKEN_FAILURES = Object.freeze({
  DISABLED: "DISABLED",
  UNAVAILABLE: "UNAVAILABLE",
  PORT_COLLISION: "PORT_COLLISION",
  MODEL_LOAD_FAILURE: "MODEL_LOAD_FAILURE",
  SERVER_FAILURE: "SERVER_FAILURE",
  GPU_OOM: "GPU_OOM",
  TIMEOUT: "TIMEOUT",
  INFERENCE_TIMEOUT: "INFERENCE_REQUEST_TIMEOUT",
  TASK_DEADLINE: "TASK_DEADLINE_EXCEEDED",
  CANCELLED: "CANCELLED",
  MALFORMED_RESULT: "MALFORMED_RESULT",
  RESULT_TOO_LARGE: "RESULT_TOO_LARGE",
  GPU_CONFLICT: "GPU_CONFLICT",
  CRASH: "CRASH",
  PROVIDER_FAILURE: "PROVIDER_FAILURE",
});

export function redactFreeTokenLog(value, { maxString = 1000 } = {}) {
  const sensitive = /(?:secret|token|password|authorization|api[_-]?key|cookie|credential|modelPath|controlUrl|serveUrl|source[_-]?body|request[_-]?body|response[_-]?body|prompt)/i;
  if (typeof value === "string") {
    const bounded = value.length > maxString ? `${value.slice(0, maxString)}...[TRUNCATED]` : value;
    return bounded.replace(/((?:secret|token|password|api[_-]?key|authorization|cookie|credential)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
  }
  if (Array.isArray(value)) return value.map((entry) => redactFreeTokenLog(entry, { maxString }));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, key.toLowerCase() === "model" ? logicalModelId(entry) : sensitive.test(key) ? "[REDACTED]" : redactFreeTokenLog(entry, { maxString })]));
}

function boundedString(value, name, max = 4096) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} must be a bounded string`);
  return value.trim();
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export function createFreeTokenConfig(input = {}, env = process.env) {
  const enabled = input.enabled ?? (env.FREETOKEN_ENABLED === "1");
  if (typeof enabled !== "boolean") throw new Error("enabled must be boolean");
  const model = input.model ?? env.FREETOKEN_MODEL ?? env.LOCAL_WORKER_MODEL ?? "";
  const modelPath = input.modelPath ?? env.FREETOKEN_MODEL_PATH ?? model;
  const controlUrl = input.controlUrl ?? env.FREETOKEN_CONTROL_URL ?? FREETOKEN_CONTROL_URL;
  const serveUrl = input.serveUrl ?? env.FREETOKEN_SERVE_URL ?? FREETOKEN_SERVE_URL;
  const deviceIndex = Number(input.deviceIndex ?? env.FREETOKEN_DEVICE_INDEX ?? 0);
  if (!Number.isInteger(deviceIndex) || deviceIndex < 0 || deviceIndex > 16) throw new Error("deviceIndex must be an integer between 0 and 16");
  if (enabled) { boundedString(model, "model", 1024); boundedString(modelPath, "modelPath", 4096); }
  const startMode = input.startMode ?? "control";
  if (!["control", "cli"].includes(startMode)) throw new Error("startMode must be control or cli");
  const localUrl = (value, name) => {
    const normalized = boundedString(String(value), name, 256).replace(/\/$/, "");
    let parsed; try { parsed = new URL(normalized); } catch { throw new Error(`${name} must be a valid loopback URL`); }
    if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname.toLowerCase())) throw new Error(`${name} must use a loopback HTTP URL`);
    return normalized;
  };
  const lifecycleRequestTimeoutMs = boundedNumber(input.lifecycleRequestTimeoutMs ?? input.requestTimeoutMs ?? 60000, 60000, 1000, 120000);
  const inferenceRequestTimeoutMs = boundedNumber(input.inferenceRequestTimeoutMs ?? env.FREETOKEN_INFERENCE_REQUEST_TIMEOUT_MS ?? 180000, 180000, 1000, 600000);
  return Object.freeze({ enabled, model: String(model), modelPath: String(modelPath), deviceIndex, controlUrl: localUrl(controlUrl, "controlUrl"), serveUrl: localUrl(serveUrl, "serveUrl"), startMode, readyTimeoutMs: boundedNumber(input.readyTimeoutMs ?? env.FREETOKEN_READY_TIMEOUT_MS ?? 75000, 75000, 1000, 120000), requestTimeoutMs: lifecycleRequestTimeoutMs, lifecycleRequestTimeoutMs, inferenceRequestTimeoutMs, idleStopMs: boundedNumber(input.idleStopMs ?? 0, 0, 0, 120000) });
}

export function classifyFreeTokenFailure(error) {
  if (!error) return null;
  if (error.code && Object.values(FREETOKEN_FAILURES).includes(error.code)) return error.code;
  const text = String(error.message || error).toLowerCase();
  if (error.name === "AbortError" || text.includes("cancel") || text.includes("aborted")) return FREETOKEN_FAILURES.CANCELLED;
  if (text.includes("timeout") || text.includes("timed out")) return FREETOKEN_FAILURES.TIMEOUT;
  if (text.includes("malformed") || text.includes("invalid response")) return FREETOKEN_FAILURES.MALFORMED_RESULT;
  if (text.includes("oversized") || text.includes("too large") || text.includes("response limit")) return FREETOKEN_FAILURES.RESULT_TOO_LARGE;
  if (text.includes("out of memory") || text.includes("cuda out of memory") || /\boom\b/.test(text)) return FREETOKEN_FAILURES.GPU_OOM;
  if (text.includes("crash") || text.includes("process exited") || text.includes("engine terminated")) return FREETOKEN_FAILURES.CRASH;
  if (text.includes("model") && (text.includes("load") || text.includes("not found") || text.includes("invalid"))) return FREETOKEN_FAILURES.MODEL_LOAD_FAILURE;
  if (text.includes("eaddrinuse") || text.includes("address already in use") || text.includes("port")) return FREETOKEN_FAILURES.PORT_COLLISION;
  return FREETOKEN_FAILURES.SERVER_FAILURE;
}

function logicalModelNames(config) {
  return [...new Set([config?.model, config?.modelPath].filter(Boolean).flatMap((value) => {
    const text = String(value).trim();
    return [text.toLowerCase(), text.replace(/\\/g, "/").split("/").pop().toLowerCase()];
  }))];
}

/** Public identity is a logical model id only; never expose a filesystem or URL path. */
export function logicalModelId(value, fallback = "unknown") {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const text = value.trim().split(/[?#]/, 1)[0].replace(/\\/g, "/").replace(/\/+$/, "");
  const basename = text.split("/").pop() || fallback;
  const safe = basename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safe) ? safe : fallback;
}

function modelEntryNames(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
  return [entry.id, entry.model, entry.name, entry.model_name, entry.modelPath].filter((value) => typeof value === "string").flatMap((value) => {
    const text = value.trim();
    return [text.toLowerCase(), text.replace(/\\/g, "/").split("/").pop().toLowerCase()];
  });
}

// Readiness is positive-schema based.  A 200 response containing an error,
// arbitrary text, or an empty model list is not evidence that inference can
// start.  `/v1/models` must expose the configured logical model identity; a
// provider-specific explicit ready field is accepted as a documented
// fallback for control/health payloads.
export function classifyFreeTokenReadiness(body, config = {}) {
  if (body === null || body === undefined) return { status: "NOT_READY", reason: "empty_readiness_payload" };
  if (!body || typeof body !== "object" || Array.isArray(body)) return { status: "MALFORMED", reason: "readiness_payload_not_object" };
  if (Object.prototype.hasOwnProperty.call(body, "error")) return { status: "MALFORMED", reason: "readiness_payload_error" };
  if (body.ready === true || body.engineRunning === true || ["ready", "healthy"].includes(String(body.status || "").toLowerCase()) || (String(body.status || "").toLowerCase() === "ok" && typeof body.model === "string" && body.model.trim())) return { status: "READY", reason: "explicit_ready_field" };
  if (Object.prototype.hasOwnProperty.call(body, "data")) {
    if (!Array.isArray(body.data)) return { status: "MALFORMED", reason: "models_data_not_array" };
    if (!body.data.length) return { status: "NOT_READY", reason: "models_data_empty" };
    const expected = logicalModelNames(config);
    if (body.data.some((entry) => modelEntryNames(entry).some((name) => expected.includes(name)))) return { status: "READY", reason: "configured_model_present" };
    return { status: "NOT_READY", reason: "configured_model_absent" };
  }
  return { status: "MALFORMED", reason: "readiness_schema_unknown" };
}

const CONTROL_FAILURE_STATES = new Set(["error", "failed", "failure", "crashed", "stopping"]);
const CONTROL_NOT_READY_STATES = new Set(["loading", "starting", "stopped", "offline", "unavailable", "not_ready", "not-ready"]);

function controlModelCompatible(body, config) {
  const expected = logicalModelNames(config);
  const advertised = [body?.model, body?.modelPath, body?.model_name, body?.modelName]
    .filter((value) => typeof value === "string" && value.trim())
    .flatMap((value) => {
      const text = value.trim();
      return [text.toLowerCase(), text.replace(/\\/g, "/").split("/").pop().toLowerCase()];
    });
  return advertised.length === 0 || advertised.some((name) => expected.includes(name));
}

// The control plane is authoritative about lifecycle state.  In particular,
// a successful `/v1/models` response cannot turn an explicit control error,
// malformed payload, or stopping/failed engine into READY.  `status: "ok"`
// alone is deliberately insufficient: a positive engine state is required.
export function classifyFreeTokenControlState(body, config = {}) {
  if (body === null || body === undefined) return { status: "UNAVAILABLE", reason: "control_health_empty" };
  if (!body || typeof body !== "object" || Array.isArray(body)) return { status: "MALFORMED", reason: "control_health_payload_not_object" };
  if (Object.prototype.hasOwnProperty.call(body, "error")) return { status: "FAILED", reason: "control_health_error" };

  const state = String(body.state ?? body.engineState ?? body.status ?? "").trim().toLowerCase();
  if (CONTROL_FAILURE_STATES.has(state)) return { status: state === "stopping" ? "STOPPING" : "FAILED", reason: `control_engine_${state}` };
  if (CONTROL_NOT_READY_STATES.has(state)) return { status: "NOT_READY", reason: `control_engine_${state}` };
  if (body.engineRunning === false || body.ready === false) return { status: "NOT_READY", reason: "control_engine_not_running" };
  if (!controlModelCompatible(body, config)) return { status: "NOT_READY", reason: "control_model_mismatch" };
  if (body.engineRunning === true || body.ready === true || ["ready", "healthy"].includes(state)) return { status: "READY", reason: "control_engine_ready" };
  if (state === "ok") return { status: "NOT_READY", reason: "control_engine_state_unconfirmed" };
  return { status: "MALFORMED", reason: "control_health_schema_unknown" };
}

export function buildFreeTokenStartPlan(input = {}) {
  const config = input.enabled !== undefined || input.model || input.modelPath || input.controlUrl || input.serveUrl ? createFreeTokenConfig(input, {}) : input;
  if (!config?.modelPath) throw new Error("modelPath required for start plan");
  return Object.freeze({ mode: config.startMode || "control", control: { method: "POST", url: `${config.controlUrl || FREETOKEN_CONTROL_URL}/engine/start`, body: { model: config.modelPath, port: 1919, args: [] } }, cli: { command: input.ftCommand || "ft", args: ["serve", "--model-path", config.modelPath, "--host", "127.0.0.1", "--port", "1919"] }, readiness: { url: `${config.serveUrl || FREETOKEN_SERVE_URL}/v1/models`, timeout_ms: config.readyTimeoutMs || 30000 } });
}

function failure(code, message, details = {}) { const error = new Error(message); error.code = code; Object.assign(error, details); return error; }

function classifyAbortReason(reason) {
  if ([FREETOKEN_FAILURES.TIMEOUT, FREETOKEN_FAILURES.INFERENCE_TIMEOUT, FREETOKEN_FAILURES.TASK_DEADLINE].includes(reason?.code)) return reason.code;
  const text = String(reason?.message || reason || "").toLowerCase();
  return text.includes("timeout") || text.includes("timed out") ? FREETOKEN_FAILURES.TIMEOUT : FREETOKEN_FAILURES.CANCELLED;
}

async function defaultRequest(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = { text: text.slice(0, 2000) }; }
  if (!response.ok) {
    const bodyText = typeof body === "string" ? body : JSON.stringify(body);
    const bodyCode = classifyFreeTokenFailure(new Error(bodyText.slice(0, 4000)));
    const code = response.status === 409 || response.status === 425 ? FREETOKEN_FAILURES.PORT_COLLISION : bodyCode === FREETOKEN_FAILURES.SERVER_FAILURE ? FREETOKEN_FAILURES.SERVER_FAILURE : bodyCode;
    throw failure(code, `FreeToken HTTP ${response.status}`, { status: response.status, body: redactFreeTokenLog(body, { maxString: 4000 }) });
  }
  const encoded = JSON.stringify(body ?? null);
  if (encoded.length > 65536) throw failure(FREETOKEN_FAILURES.RESULT_TOO_LARGE, "FreeToken response exceeds evidence limit");
  return { status: response.status, body };
}

// The provider request is an extension point and may ignore AbortSignal (for
// example, a native bridge or a test double). Keep cancellation bounded at the
// parent boundary regardless of cooperative transport behavior. The late
// request promise always gets a rejection handler so a post-timeout failure
// cannot become an unhandled rejection.
function boundedRequest(request, url, options = {}, { signal = null, timeoutMs = 60000, timeoutCode = FREETOKEN_FAILURES.TIMEOUT } = {}) {
  const boundedTimeout = Math.max(1, Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : 60000);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const code = classifyAbortReason(signal.reason);
      reject(failure(code, code === FREETOKEN_FAILURES.TIMEOUT || code === FREETOKEN_FAILURES.INFERENCE_TIMEOUT ? "FreeToken request timeout before dispatch" : "FreeToken request cancelled before dispatch"));
      return;
    }
    const controller = new AbortController();
    let timer = null;
    let onAbort = null;
    let settled = false;
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      onAbort = null;
    };
    const settle = (settler, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      settler(value);
    };
    onAbort = () => {
      try { controller.abort(signal.reason); } catch { /* already aborted */ }
      const code = classifyAbortReason(signal.reason);
      settle(reject, failure(code, code === FREETOKEN_FAILURES.TIMEOUT || code === FREETOKEN_FAILURES.INFERENCE_TIMEOUT ? "FreeToken request timeout" : "FreeToken request cancelled"));
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      try { controller.abort(new Error("request timeout")); } catch { /* already aborted */ }
      settle(reject, failure(timeoutCode, "FreeToken request timeout"));
    }, boundedTimeout);
    let pending;
    try {
      pending = Promise.resolve(request(url, { ...options, signal: controller.signal }));
    } catch (error) {
      settle(reject, error);
      return;
    }
    pending.then(
      (value) => settle(resolve, value),
      (error) => settle(reject, error),
    );
  });
}

function abortableSignal(signal, timeoutMs, timeoutCode = FREETOKEN_FAILURES.TASK_DEADLINE) {
  const controller = new AbortController();
  const timer = setTimeout(() => { const error = failure(timeoutCode, timeoutCode === FREETOKEN_FAILURES.TASK_DEADLINE ? "FreeToken task deadline exceeded" : "FreeToken request timeout"); controller.abort(error); }, Math.max(1, timeoutMs));
  let onAbort = null;
  if (signal) {
    onAbort = () => controller.abort(signal.reason);
    if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
  }
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); if (signal && onAbort) signal.removeEventListener("abort", onAbort); onAbort = null; } };
}

export function classifyGpuConflict(mapping, gpuRows, deviceIndex = 0) {
  const target = (Array.isArray(gpuRows) ? gpuRows : []).find((row) => Number(String(Array.isArray(row) ? row[0] : row?.index).trim()) === deviceIndex);
  const targetUuid = String(Array.isArray(target) ? target?.[1] : target?.uuid || "").trim().toLowerCase();
  if (!targetUuid) return { status: "UNAVAILABLE", reason: "target_gpu_not_found", device_index: deviceIndex };
  const targetIndex = String(deviceIndex);
  const busy = String(mapping || "").split(/\r?\n/).some((line) => {
    const fields = line.split(",").map((value) => value.trim());
    if (!fields.length) return false;
    // nvidia-smi compute-app rows can contain UUIDs; WDDM/Resolve variants
    // may expose an index or [N/A] used-memory. Any matching row is a
    // conflict: memory text is not a reliable compute-client discriminator.
    return fields[0].toLowerCase() === targetUuid || fields[0] === targetIndex;
  });
  return busy
    ? { status: "CONFLICT", code: FREETOKEN_FAILURES.GPU_CONFLICT, reason: "existing_gpu_compute_workload_on_target_device", device_index: deviceIndex }
    : { status: "CLEAR", reason: "no_known_gpu_compute_workload_on_target_device", device_index: deviceIndex };
}

export function defaultGpuConflictProbe(deviceIndex = 0, { execFileSyncImpl = execFileSync } = {}) {
  try {
    const mapping = execFileSyncImpl("nvidia-smi", ["--query-compute-apps=gpu_uuid,pid,process_name,used_memory", "--format=csv,noheader,nounits"], { encoding: "utf8", windowsHide: true, timeout: 5000 }).trim();
    const uuids = execFileSyncImpl("nvidia-smi", ["--query-gpu=index,uuid", "--format=csv,noheader,nounits"], { encoding: "utf8", windowsHide: true, timeout: 5000 }).trim().split(/\r?\n/).filter(Boolean).map((line) => line.split(",").map((x) => x.trim()));
    return classifyGpuConflict(mapping, uuids, deviceIndex);
  } catch { return { status: "UNAVAILABLE", reason: "gpu_device_mapping_unavailable", device_index: deviceIndex }; }
}

export function killOwnedProcessTree(child, { platform = process.platform, taskkill = null } = {}) {
  if (!child || !Number.isInteger(child.pid)) return false;
  try {
    if (platform === "win32") (taskkill || ((pid) => execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10000 })))(child.pid);
    else { try { process.kill(-child.pid, "SIGKILL"); } catch { process.kill(child.pid, "SIGKILL"); } }
    return true;
  } catch { return false; }
}

export function createFreeTokenInferenceAdapter(options = {}) {
  const config = createFreeTokenConfig(options.config || options, options.env || process.env);
  const request = options.request || defaultRequest;
  const gpuProbe = options.gpuProbe || (() => defaultGpuConflictProbe(config.deviceIndex));
  const spawnImpl = options.spawnImpl || spawn;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = options.log || (() => {});
  let ownedProcess = null;
  let startedByAdapter = false;
  let startedViaControl = false;
  let stopping = null;

  const identity = Object.freeze({ runtime: "local", provider: "freetoken", model: logicalModelId(config.model, "unconfigured"), device_index: config.deviceIndex, control_url: config.controlUrl, serve_url: config.serveUrl });
  async function get(path, base = config.controlUrl, signal = null, timeoutMs = config.requestTimeoutMs) {
    return boundedRequest(request, `${base}${path}`, { method: "GET" }, { signal, timeoutMs });
  }
  async function health(signal = null) {
    if (!config.enabled) return { status: "DISABLED", code: FREETOKEN_FAILURES.DISABLED, control: null, serve: null };
    let control = null; let serve = null; let controlError = null; let serveError = null;
    const observed = await Promise.all([
      get("/health", config.controlUrl, signal).then((result) => ({ body: result.body }), (error) => ({ error })),
      get("/v1/models", config.serveUrl, signal).then((result) => ({ body: result.body }), (error) => ({ error })),
    ]);
    control = observed[0].body ?? null; controlError = observed[0].error || null;
    serve = observed[1].body ?? null; serveError = observed[1].error || null;

    const boundedFailure = (error) => [FREETOKEN_FAILURES.CANCELLED, FREETOKEN_FAILURES.TIMEOUT, FREETOKEN_FAILURES.INFERENCE_TIMEOUT, FREETOKEN_FAILURES.TASK_DEADLINE].includes(error?.code) ? error.code : null;
    const controlBoundedCode = boundedFailure(controlError);
    const serveBoundedCode = boundedFailure(serveError);
    if (controlBoundedCode || serveBoundedCode) {
      const code = controlBoundedCode || serveBoundedCode;
      const status = code === FREETOKEN_FAILURES.CANCELLED ? "CANCELLED" : "TIMEOUT";
      return { status, ownership: "UNKNOWN", owned: false, code, reason: code === FREETOKEN_FAILURES.CANCELLED ? "control_or_serve_cancelled" : "control_or_serve_timeout", control, serve, control_readiness: { status, reason: "bounded_request" }, serve_readiness: classifyFreeTokenReadiness(serve, config), control_error: controlError ? String(controlError.message || controlError) : null, serve_error: serveError ? String(serveError.message || serveError) : null };
    }

    const serveReadiness = classifyFreeTokenReadiness(serve, config);
    const serveReady = serveReadiness.status === "READY";
    // A transport failure with no HTTP status means the control plane cannot
    // be observed.  A serve endpoint that positively advertises the configured
    // model is safe to reuse, but ownership remains EXTERNAL/unknown and stop()
    // must not be sent for it.  HTTP failures and malformed/explicit control
    // states remain authoritative failures and cannot be masked by serve.
    if (controlError) {
      const httpFailure = Number.isFinite(Number(controlError?.status));
      if (!httpFailure && serveReady) {
        return { status: "READY", ownership: "EXTERNAL", owned: false, code: null, reason: "external_serve_ready_control_unavailable", control: null, serve, control_readiness: { status: "UNAVAILABLE", reason: "control_health_unavailable" }, serve_readiness: serveReadiness, control_error: String(controlError.message || controlError), serve_error: serveError ? String(serveError.message || serveError) : null };
      }
      const status = httpFailure ? "FAILED" : "UNAVAILABLE";
      return { status, ownership: "UNKNOWN", owned: false, code: httpFailure ? FREETOKEN_FAILURES.SERVER_FAILURE : FREETOKEN_FAILURES.UNAVAILABLE, reason: httpFailure ? "control_health_http_failure" : "control_health_unavailable", control: null, serve, control_readiness: { status, reason: "control_health_unavailable" }, serve_readiness: serveReadiness, control_error: String(controlError.message || controlError), serve_error: serveError ? String(serveError.message || serveError) : null };
    }

    const controlReadiness = classifyFreeTokenControlState(control, config);
    // Control error/malformed/failure/stopping states dominate even when the
    // serve endpoint still exposes a stale or externally running model.
    if (controlReadiness.status !== "READY") {
      const code = controlReadiness.status === "MALFORMED" ? FREETOKEN_FAILURES.MALFORMED_RESULT : ["FAILED", "STOPPING"].includes(controlReadiness.status) ? FREETOKEN_FAILURES.SERVER_FAILURE : null;
      return { status: controlReadiness.status, ownership: "UNKNOWN", owned: false, code, reason: controlReadiness.reason, control, serve, control_readiness: controlReadiness, serve_readiness: serveReadiness, serve_error: serveError ? String(serveError.message || serveError) : null };
    }
    if (!serveReady) {
      return { status: serveReadiness.status, ownership: "UNKNOWN", owned: false, code: serveReadiness.status === "MALFORMED" ? FREETOKEN_FAILURES.MALFORMED_RESULT : null, reason: serveReadiness.reason, control, serve, control_readiness: controlReadiness, serve_readiness: serveReadiness, serve_error: serveError ? String(serveError.message || serveError) : null };
    }
    return { status: "READY", ownership: "EXTERNAL", owned: false, code: null, reason: "control_and_serve_ready", control, serve, control_readiness: controlReadiness, serve_readiness: serveReadiness };
  }
  async function waitReady(signal) {
    const started = Date.now(); let last = null;
    while (Date.now() - started <= config.readyTimeoutMs) {
      if (signal?.aborted) throw failure(FREETOKEN_FAILURES.CANCELLED, "FreeToken readiness cancelled");
      try {
        const remaining = Math.max(1, config.readyTimeoutMs - (Date.now() - started));
        const result = await get("/v1/models", config.serveUrl, signal, Math.min(config.requestTimeoutMs, remaining));
        const readiness = classifyFreeTokenReadiness(result.body, config);
        if (readiness.status === "READY") return result.body;
        if (readiness.status === "MALFORMED") last = failure(FREETOKEN_FAILURES.MALFORMED_RESULT, readiness.reason);
      } catch (error) {
        last = error;
        if (error?.code === FREETOKEN_FAILURES.CANCELLED && signal?.aborted) throw error;
      }
      await sleep(100);
    }
    if (last?.code === FREETOKEN_FAILURES.MALFORMED_RESULT) throw failure(FREETOKEN_FAILURES.MALFORMED_RESULT, "FreeToken readiness payload malformed", { cause: last?.message });
    throw failure(FREETOKEN_FAILURES.TIMEOUT, "FreeToken readiness timeout", { cause: last?.message });
  }
  async function start({ signal, onLifecycle } = {}) {
    if (!config.enabled) return { status: "BLOCKED", code: FREETOKEN_FAILURES.DISABLED, reason: "provider disabled" };
    onLifecycle?.("gpu_gate_start");
    const gate = await Promise.resolve(gpuProbe());
    onLifecycle?.("gpu_gate_end");
    if (!gate || gate.status !== "CLEAR") return { status: "BLOCKED", code: (gate?.code && Object.values(FREETOKEN_FAILURES).includes(gate.code)) ? gate.code : gate?.status === "CONFLICT" ? FREETOKEN_FAILURES.GPU_CONFLICT : FREETOKEN_FAILURES.UNAVAILABLE, reason: gate?.reason || "GPU conflict or probe unavailable", gpu: gate || null };
    onLifecycle?.("start_start");
    if (signal?.aborted) { const code = classifyAbortReason(signal.reason); return { status: "BLOCKED", code, reason: code === FREETOKEN_FAILURES.TASK_DEADLINE ? "task deadline exceeded before health" : "start cancelled before health" }; }
    const current = await health(signal);
    if (current.status === "READY") { onLifecycle?.("start_end"); onLifecycle?.("ready_start"); onLifecycle?.("ready_end"); return { status: "READY", owned: false, health: current }; }
    if (["FAILED", "MALFORMED", "STOPPING", "CANCELLED", "TIMEOUT"].includes(current.status)) {
      return { status: "BLOCKED", code: current.code || FREETOKEN_FAILURES.SERVER_FAILURE, reason: `control health ${String(current.status).toLowerCase()}`, health: current };
    }
    // Only clean up a process previously spawned by this adapter. A stale
    // owned handle must not cause a second server to be started on the same
    // port; externally running FreeToken/LM Studio remains untouched.
    if (ownedProcess) { try { killOwnedProcessTree(ownedProcess, options); } catch { /* best effort */ } ownedProcess = null; startedByAdapter = false; }
    try {
      if (config.startMode === "cli") {
        const args = ["serve", "--model-path", config.modelPath, "--host", "127.0.0.1", "--port", "1919"];
        ownedProcess = spawnImpl(options.ftCommand || "ft", args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        startedByAdapter = true;
        const spawnedProcess = ownedProcess;
        ownedProcess.once?.("exit", () => { if (ownedProcess === spawnedProcess) ownedProcess = null; });
      } else {
        await boundedRequest(request, `${config.controlUrl}/engine/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: config.modelPath, port: 1919, args: [] }) }, { signal, timeoutMs: config.requestTimeoutMs });
        startedByAdapter = true;
        startedViaControl = true;
      }
      onLifecycle?.("start_end");
      onLifecycle?.("ready_start");
      const ready = await waitReady(signal);
      onLifecycle?.("ready_end");
      return { status: "READY", owned: startedByAdapter, ready };
    } catch (error) {
      const code = signal?.aborted ? classifyAbortReason(signal.reason) : classifyFreeTokenFailure(error);
      await stop();
      return { status: "BLOCKED", code, reason: String(error.message || error) };
    }
  }
  // The runtime parent uses this read-only gate before acquiring its
  // single-host lease. start() repeats the probe immediately before provider
  // use, so a workload that appears in between still blocks rather than being
  // stopped or displaced.
  async function gpuGate() { return Promise.resolve(gpuProbe()); }
  async function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      if (ownedProcess) { killOwnedProcessTree(ownedProcess, options); ownedProcess = null; }
      if (startedViaControl) { try { await boundedRequest(request, `${config.controlUrl}/engine/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ force: false }) }, { timeoutMs: config.requestTimeoutMs }); } catch { /* cleanup is best effort */ } }
      startedByAdapter = false;
      startedViaControl = false;
      stopping = null;
      return { status: "STOPPED" };
    })();
    return stopping;
  }
  async function run(task, context = {}) {
    if (!config.enabled) return { status: "BLOCKED", code: FREETOKEN_FAILURES.DISABLED, reason: "provider disabled" };
    const started = Date.now();
    const taskIsObject = task && typeof task === "object";
    const taskTimeoutMs = taskIsObject && Number.isInteger(task.timeout) ? task.timeout : config.inferenceRequestTimeoutMs;
    const runDeadline = started + Math.max(1000, Math.min(3_600_000, taskTimeoutMs));
    const runBudget = Math.max(1, runDeadline - Date.now());
    const runSignal = abortableSignal(context.signal, runBudget, FREETOKEN_FAILURES.TASK_DEADLINE);
    const lifecycle = await start({ signal: runSignal.signal, onLifecycle: context.onLifecycle });
    if (lifecycle.status !== "READY") { runSignal.dispose(); return lifecycle; }
    const prompt = typeof task === "string" ? task : task.prompt || task.goal;
    if (!prompt || typeof prompt !== "string") { runSignal.dispose(); return { status: "FAILED", code: FREETOKEN_FAILURES.SERVER_FAILURE, reason: "prompt required" }; }
    const bounded = prompt.slice(0, 12000);
    try {
      context.onLifecycle?.("inference_start");
      const harnessTask = typeof task === "string"
        ? { goal: bounded, repo: "(provider)", worktree: "(provider)", allowed_paths: [], max_tool_calls: 8, timeout: config.requestTimeoutMs, output_limit: 12000 }
        : { repo: "(provider)", worktree: "(provider)", allowed_paths: [], max_tool_calls: 8, timeout: config.requestTimeoutMs, output_limit: 12000, ...task, goal: task.goal || task.prompt || bounded, allowed_paths: Array.isArray(task.allowed_paths) ? task.allowed_paths : [] };
      const harness = await runMinimalHarness(harnessTask, {
        signal: runSignal.signal,
        runTest: context.runTest,
        maxToolCalls: task && typeof task === "object" ? task.max_tool_calls : 8,
        timeoutMs: Math.max(1, runDeadline - Date.now()),
        outputLimit: task && typeof task === "object" ? task.output_limit : 12000,
        logger: (event) => log(redactFreeTokenLog({ event: "freetoken_harness", ...event })),
        infer: async ({ messages, tools, tool_choice, max_tokens, signal }) => {
          // The HTTP server binds before the scheduler has finished loading
          // weights. Retry only that transient 503 window; persistent model
          // load failures still surface after a bounded number of attempts.
          let lastError = null;
          const retryDeadline = Math.min(runDeadline, Date.now() + Math.max(1000, Math.min(config.inferenceRequestTimeoutMs - 1000, 60000)));
          for (let attempt = 0; attempt < 60 && Date.now() < retryDeadline; attempt += 1) {
            try {
              const response = await boundedRequest(request, `${config.serveUrl}/v1/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ model: config.model, messages, tools, tool_choice, max_tokens: max_tokens ?? task?.max_tokens ?? 1024 }),
              }, { signal, timeoutMs: Math.max(1, Math.min(config.inferenceRequestTimeoutMs, runDeadline - Date.now())), timeoutCode: FREETOKEN_FAILURES.INFERENCE_TIMEOUT });
              if (!response || !response.body || typeof response.body !== "object" || Array.isArray(response.body)) throw failure(FREETOKEN_FAILURES.MALFORMED_RESULT, "FreeToken response body is malformed");
              let encoded; try { encoded = JSON.stringify(response.body); } catch { throw failure(FREETOKEN_FAILURES.MALFORMED_RESULT, "FreeToken response body is not serializable"); }
              if (encoded.length > 65536) throw failure(FREETOKEN_FAILURES.RESULT_TOO_LARGE, "FreeToken response exceeds evidence limit");
              return response.body;
            } catch (error) {
              lastError = error;
              const status = Number(error?.status);
              const transient = status === 503 || /HTTP 503|service unavailable|scheduler.*ready/i.test(String(error?.message || error));
              if (!transient || signal?.aborted || attempt === 59 || Date.now() >= retryDeadline) throw error;
              await sleep(1000);
            }
          }
          throw lastError || failure(FREETOKEN_FAILURES.SERVER_FAILURE, "FreeToken inference failed");
        },
      });
      const mappedCode = harness.code === "CANCELLED" ? FREETOKEN_FAILURES.CANCELLED : harness.code === "HARNESS_TIMEOUT" ? FREETOKEN_FAILURES.TASK_DEADLINE : harness.code === "MALFORMED_RESULT" ? FREETOKEN_FAILURES.MALFORMED_RESULT : harness.status === "BLOCKED" ? FREETOKEN_FAILURES.SERVER_FAILURE : null;
      const result = { status: harness.status, code: mappedCode || harness.code || undefined, reason: harness.reason, response: harness.response, summary: harness.summary, tool_calls: harness.tool_calls, observations: harness.observations, metrics: { wall_time_ms: Date.now() - started, prompt_chars: bounded.length, ...(harness.metrics || {}) } };
      context.onLifecycle?.("inference_end");
       log(redactFreeTokenLog({ event: "freetoken_inference", status: result.status, model: logicalModelId(config.model, "unconfigured"), wall_time_ms: result.metrics.wall_time_ms, prompt_chars: bounded.length }));
      return result;
    } catch (error) {
      const code = runSignal.signal.aborted ? classifyAbortReason(runSignal.signal.reason) : context.signal?.aborted ? FREETOKEN_FAILURES.CANCELLED : classifyFreeTokenFailure(error);
      const result = { status: code === FREETOKEN_FAILURES.CANCELLED ? "CANCELLED" : "FAILED", code, reason: String(error.message || error), metrics: { wall_time_ms: Date.now() - started } };
      log(redactFreeTokenLog({ event: "freetoken_inference", status: result.status, code, model: logicalModelId(config.model, "unconfigured"), wall_time_ms: result.metrics.wall_time_ms }));
      return result;
    } finally {
      context.onLifecycle?.("inference_end");
      context.onLifecycle?.("cleanup_start");
      runSignal.dispose();
      if (config.idleStopMs === 0) await stop(); else setTimeout(() => { void stop(); }, config.idleStopMs).unref?.();
      context.onLifecycle?.("cleanup_end");
    }
  }
  return Object.freeze({ identity, config, health, start, run, stop, waitReady, gpuGate });
}
