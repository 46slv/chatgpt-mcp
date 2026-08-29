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
  CANCELLED: "CANCELLED",
  MALFORMED_RESULT: "MALFORMED_RESULT",
  RESULT_TOO_LARGE: "RESULT_TOO_LARGE",
});

export function redactFreeTokenLog(value, { maxString = 1000 } = {}) {
  const sensitive = /(?:secret|token|password|authorization|api[_-]?key|cookie|credential|modelPath|controlUrl|serveUrl|source[_-]?body|request[_-]?body|response[_-]?body|prompt)/i;
  if (typeof value === "string") {
    const bounded = value.length > maxString ? `${value.slice(0, maxString)}...[TRUNCATED]` : value;
    return bounded.replace(/((?:secret|token|password|api[_-]?key|authorization|cookie|credential)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
  }
  if (Array.isArray(value)) return value.map((entry) => redactFreeTokenLog(entry, { maxString }));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sensitive.test(key) ? "[REDACTED]" : redactFreeTokenLog(entry, { maxString })]));
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
  return Object.freeze({ enabled, model: String(model), modelPath: String(modelPath), deviceIndex, controlUrl: localUrl(controlUrl, "controlUrl"), serveUrl: localUrl(serveUrl, "serveUrl"), startMode, readyTimeoutMs: boundedNumber(input.readyTimeoutMs ?? 30000, 30000, 1000, 120000), requestTimeoutMs: boundedNumber(input.requestTimeoutMs ?? 60000, 60000, 1000, 120000), idleStopMs: boundedNumber(input.idleStopMs ?? 0, 0, 0, 120000) });
}

export function classifyFreeTokenFailure(error) {
  if (!error) return null;
  if (error.code && Object.values(FREETOKEN_FAILURES).includes(error.code)) return error.code;
  const text = String(error.message || error).toLowerCase();
  if (text.includes("cancel")) return FREETOKEN_FAILURES.CANCELLED;
  if (text.includes("timeout") || text.includes("timed out") || text.includes("aborted")) return FREETOKEN_FAILURES.TIMEOUT;
  if (text.includes("malformed") || text.includes("invalid response")) return FREETOKEN_FAILURES.MALFORMED_RESULT;
  if (text.includes("oversized") || text.includes("too large") || text.includes("response limit")) return FREETOKEN_FAILURES.RESULT_TOO_LARGE;
  if (text.includes("out of memory") || text.includes("cuda out of memory") || /\boom\b/.test(text)) return FREETOKEN_FAILURES.GPU_OOM;
  if (text.includes("model") && (text.includes("load") || text.includes("not found") || text.includes("invalid"))) return FREETOKEN_FAILURES.MODEL_LOAD_FAILURE;
  if (text.includes("eaddrinuse") || text.includes("address already in use") || text.includes("port")) return FREETOKEN_FAILURES.PORT_COLLISION;
  return FREETOKEN_FAILURES.SERVER_FAILURE;
}

export function buildFreeTokenStartPlan(input = {}) {
  const config = input.enabled !== undefined || input.model || input.modelPath || input.controlUrl || input.serveUrl ? createFreeTokenConfig(input, {}) : input;
  if (!config?.modelPath) throw new Error("modelPath required for start plan");
  return Object.freeze({ mode: config.startMode || "control", control: { method: "POST", url: `${config.controlUrl || FREETOKEN_CONTROL_URL}/engine/start`, body: { model: config.modelPath, port: 1919, args: [] } }, cli: { command: input.ftCommand || "ft", args: ["serve", "--model-path", config.modelPath, "--host", "127.0.0.1", "--port", "1919"] }, readiness: { url: `${config.serveUrl || FREETOKEN_SERVE_URL}/health`, timeout_ms: config.readyTimeoutMs || 30000 } });
}

function failure(code, message, details = {}) { const error = new Error(message); error.code = code; Object.assign(error, details); return error; }

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

function abortableSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("request timeout")), timeoutMs);
  if (signal) { if (signal.aborted) controller.abort(signal.reason); else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true }); }
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

export function defaultGpuConflictProbe(deviceIndex = 0) {
  try {
    const mapping = execFileSync("nvidia-smi", ["--query-compute-apps=gpu_uuid,pid,process_name,used_memory", "--format=csv,noheader,nounits"], { encoding: "utf8", windowsHide: true, timeout: 5000 }).trim();
    const uuids = execFileSync("nvidia-smi", ["--query-gpu=index,uuid", "--format=csv,noheader,nounits"], { encoding: "utf8", windowsHide: true, timeout: 5000 }).trim().split(/\r?\n/).map((line) => line.split(",").map((x) => x.trim()));
    const targetUuid = uuids.find(([index]) => Number(index) === deviceIndex)?.[1];
    if (!targetUuid) return { status: "UNAVAILABLE", reason: "target_gpu_not_found", device_index: deviceIndex };
    const targetBusy = mapping.split(/\r?\n/).some((line) => {
      if (!line.toLowerCase().startsWith(targetUuid.toLowerCase())) return false;
      // nvidia-smi also reports graphics clients with a trailing [N/A]. They
      // do not reserve CUDA compute memory and are not a model conflict.
      const used = line.match(/,\s*([0-9]+(?:\.[0-9]+)?)\s*$/);
      return !!used && Number(used[1]) > 0;
    });
    if (targetBusy) return { status: "CONFLICT", reason: "existing_gpu_compute_workload_on_target_device", device_index: deviceIndex };
    return { status: "CLEAR", reason: "no_known_gpu_compute_workload_on_target_device", device_index: deviceIndex };
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

  const identity = Object.freeze({ runtime: "local", provider: "freetoken", model: config.model || "unconfigured", device_index: config.deviceIndex, control_url: config.controlUrl, serve_url: config.serveUrl });
  async function get(path, base = config.controlUrl) { return request(`${base}${path}`, { method: "GET" }); }
  async function health() {
    if (!config.enabled) return { status: "DISABLED", code: FREETOKEN_FAILURES.DISABLED, control: null, serve: null };
    let control = null; let serve = null;
    try { control = (await get("/health")).body; } catch (error) { return { status: "UNAVAILABLE", code: FREETOKEN_FAILURES.UNAVAILABLE, reason: String(error.message || error) }; }
    try { serve = (await get("/health", config.serveUrl)).body; } catch { /* readiness is false while stopped */ }
    return { status: control?.engineRunning || control?.status === "ok" ? (serve ? "READY" : "CONTROL_READY") : "IDLE", code: null, control, serve };
  }
  async function waitReady(signal) {
    const started = Date.now(); let last = null;
    while (Date.now() - started <= config.readyTimeoutMs) {
      if (signal?.aborted) throw failure(FREETOKEN_FAILURES.CANCELLED, "FreeToken readiness cancelled");
      try { const result = await get("/health", config.serveUrl); if (result.body?.status === "ok" || result.body?.ready === true || result.body?.model) return result.body; } catch (error) { last = error; }
      await sleep(100);
    }
    throw failure(FREETOKEN_FAILURES.TIMEOUT, "FreeToken readiness timeout", { cause: last?.message });
  }
  async function start({ signal } = {}) {
    if (!config.enabled) return { status: "BLOCKED", code: FREETOKEN_FAILURES.DISABLED, reason: "provider disabled" };
    const gate = await Promise.resolve(gpuProbe());
    if (!gate || gate.status !== "CLEAR") return { status: "BLOCKED", code: (gate?.code && Object.values(FREETOKEN_FAILURES).includes(gate.code)) ? gate.code : FREETOKEN_FAILURES.UNAVAILABLE, reason: gate?.reason || "GPU conflict or probe unavailable", gpu: gate || null };
    const current = await health();
    if (current.status === "READY") return { status: "READY", owned: false, health: current };
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
        await request(`${config.controlUrl}/engine/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: config.modelPath, port: 1919, args: [] }), signal });
        startedByAdapter = true;
        startedViaControl = true;
      }
      const ready = await waitReady(signal);
      return { status: "READY", owned: startedByAdapter, ready };
    } catch (error) {
      const code = signal?.aborted ? FREETOKEN_FAILURES.CANCELLED : classifyFreeTokenFailure(error);
      await stop();
      return { status: "BLOCKED", code, reason: String(error.message || error) };
    }
  }
  async function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      if (ownedProcess) { killOwnedProcessTree(ownedProcess, options); ownedProcess = null; }
      if (startedViaControl) { try { await request(`${config.controlUrl}/engine/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ force: false }) }); } catch { /* cleanup is best effort */ } }
      startedByAdapter = false;
      startedViaControl = false;
      stopping = null;
      return { status: "STOPPED" };
    })();
    return stopping;
  }
  async function run(task, context = {}) {
    if (!config.enabled) return { status: "BLOCKED", code: FREETOKEN_FAILURES.DISABLED, reason: "provider disabled" };
    const started = Date.now(); const lifecycle = await start({ signal: context.signal });
    if (lifecycle.status !== "READY") return lifecycle;
    const prompt = typeof task === "string" ? task : task.prompt || task.goal;
    if (!prompt || typeof prompt !== "string") return { status: "FAILED", code: FREETOKEN_FAILURES.SERVER_FAILURE, reason: "prompt required" };
    const bounded = prompt.slice(0, 12000); const timer = abortableSignal(context.signal, config.requestTimeoutMs);
    try {
      const harnessTask = typeof task === "string"
        ? { goal: bounded, repo: "(provider)", worktree: "(provider)", allowed_paths: [], max_tool_calls: 8, timeout: config.requestTimeoutMs, output_limit: 12000 }
        : { repo: "(provider)", worktree: "(provider)", allowed_paths: [], max_tool_calls: 8, timeout: config.requestTimeoutMs, output_limit: 12000, ...task, goal: task.goal || task.prompt || bounded, allowed_paths: Array.isArray(task.allowed_paths) ? task.allowed_paths : [] };
      const harness = await runMinimalHarness(harnessTask, {
        signal: timer.signal,
        runTest: context.runTest,
        maxToolCalls: task && typeof task === "object" ? task.max_tool_calls : 8,
        timeoutMs: task && typeof task === "object" ? task.timeout : config.requestTimeoutMs,
        outputLimit: task && typeof task === "object" ? task.output_limit : 12000,
        logger: (event) => log(redactFreeTokenLog({ event: "freetoken_harness", ...event })),
        infer: async ({ messages, tools, tool_choice, max_tokens, signal }) => {
          const response = await request(`${config.serveUrl}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: config.model, messages, tools, tool_choice, max_tokens: max_tokens ?? task?.max_tokens ?? 1024 }),
            signal,
          });
          if (!response || !response.body || typeof response.body !== "object" || Array.isArray(response.body)) throw failure(FREETOKEN_FAILURES.MALFORMED_RESULT, "FreeToken response body is malformed");
          let encoded; try { encoded = JSON.stringify(response.body); } catch { throw failure(FREETOKEN_FAILURES.MALFORMED_RESULT, "FreeToken response body is not serializable"); }
          if (encoded.length > 65536) throw failure(FREETOKEN_FAILURES.RESULT_TOO_LARGE, "FreeToken response exceeds evidence limit");
          return response.body;
        },
      });
      const mappedCode = harness.code === "CANCELLED" ? FREETOKEN_FAILURES.CANCELLED : harness.code === "HARNESS_TIMEOUT" ? FREETOKEN_FAILURES.TIMEOUT : harness.code === "MALFORMED_RESULT" ? FREETOKEN_FAILURES.MALFORMED_RESULT : harness.status === "BLOCKED" ? FREETOKEN_FAILURES.SERVER_FAILURE : null;
      const result = { status: harness.status, code: mappedCode || harness.code || undefined, reason: harness.reason, response: harness.response, summary: harness.summary, tool_calls: harness.tool_calls, observations: harness.observations, metrics: { wall_time_ms: Date.now() - started, prompt_chars: bounded.length, ...(harness.metrics || {}) } };
      log(redactFreeTokenLog({ event: "freetoken_inference", status: result.status, model: config.model, wall_time_ms: result.metrics.wall_time_ms, prompt_chars: bounded.length }));
      return result;
    } catch (error) {
      const code = context.signal?.aborted ? FREETOKEN_FAILURES.CANCELLED : classifyFreeTokenFailure(error);
      const result = { status: code === FREETOKEN_FAILURES.CANCELLED ? "CANCELLED" : "FAILED", code, reason: String(error.message || error), metrics: { wall_time_ms: Date.now() - started } };
      log(redactFreeTokenLog({ event: "freetoken_inference", status: result.status, code, model: config.model, wall_time_ms: result.metrics.wall_time_ms }));
      return result;
    } finally { timer.dispose(); if (config.idleStopMs === 0) await stop(); else setTimeout(() => { void stop(); }, config.idleStopMs).unref?.(); }
  }
  return Object.freeze({ identity, config, health, start, run, stop, waitReady });
}
