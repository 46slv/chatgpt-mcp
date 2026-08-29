import { execFileSync, spawn } from "node:child_process";

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
});

export function redactFreeTokenLog(value, { maxString = 1000 } = {}) {
  const sensitive = /(?:secret|token|password|authorization|api[_-]?key|cookie|credential|modelPath|controlUrl|serveUrl)/i;
  if (typeof value === "string") return value.length > maxString ? `${value.slice(0, maxString)}...[TRUNCATED]` : value;
  if (Array.isArray(value)) return value.map((entry) => redactFreeTokenLog(entry, { maxString }));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sensitive.test(key) ? "[REDACTED]" : redactFreeTokenLog(entry, { maxString })]));
}

function boundedString(value, name, max = 4096) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} must be a bounded string`);
  return value.trim();
}

export function createFreeTokenConfig(input = {}, env = process.env) {
  const enabled = input.enabled ?? (env.FREETOKEN_ENABLED === "1");
  if (typeof enabled !== "boolean") throw new Error("enabled must be boolean");
  const model = input.model ?? env.FREETOKEN_MODEL ?? env.LOCAL_WORKER_MODEL ?? "";
  const modelPath = input.modelPath ?? env.FREETOKEN_MODEL_PATH ?? model;
  const controlUrl = input.controlUrl ?? env.FREETOKEN_CONTROL_URL ?? FREETOKEN_CONTROL_URL;
  const serveUrl = input.serveUrl ?? env.FREETOKEN_SERVE_URL ?? FREETOKEN_SERVE_URL;
  if (enabled) { boundedString(model, "model", 1024); boundedString(modelPath, "modelPath", 4096); }
  return Object.freeze({ enabled, model: String(model), modelPath: String(modelPath), controlUrl: boundedString(String(controlUrl), "controlUrl", 256).replace(/\/$/, ""), serveUrl: boundedString(String(serveUrl), "serveUrl", 256).replace(/\/$/, ""), startMode: input.startMode ?? "control", readyTimeoutMs: Math.min(120000, Math.max(1000, Number(input.readyTimeoutMs ?? 30000))), requestTimeoutMs: Math.min(120000, Math.max(1000, Number(input.requestTimeoutMs ?? 60000))), idleStopMs: Math.min(120000, Math.max(0, Number(input.idleStopMs ?? 0))) });
}

export function classifyFreeTokenFailure(error) {
  if (!error) return null;
  if (error.code && Object.values(FREETOKEN_FAILURES).includes(error.code)) return error.code;
  const text = String(error.message || error).toLowerCase();
  if (text.includes("cancel")) return FREETOKEN_FAILURES.CANCELLED;
  if (text.includes("timeout") || text.includes("timed out") || text.includes("aborted")) return FREETOKEN_FAILURES.TIMEOUT;
  if (text.includes("out of memory") || text.includes("cuda out of memory") || /\boom\b/.test(text)) return FREETOKEN_FAILURES.GPU_OOM;
  if (text.includes("model") && (text.includes("load") || text.includes("not found") || text.includes("invalid"))) return FREETOKEN_FAILURES.MODEL_LOAD_FAILURE;
  if (text.includes("eaddrinuse") || text.includes("address already in use") || text.includes("port")) return FREETOKEN_FAILURES.PORT_COLLISION;
  return FREETOKEN_FAILURES.SERVER_FAILURE;
}

function failure(code, message, details = {}) { const error = new Error(message); error.code = code; Object.assign(error, details); return error; }

async function defaultRequest(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = { text: text.slice(0, 2000) }; }
  if (!response.ok) throw failure(response.status === 409 || response.status === 425 ? FREETOKEN_FAILURES.PORT_COLLISION : FREETOKEN_FAILURES.SERVER_FAILURE, `FreeToken HTTP ${response.status}`, { status: response.status, body });
  return { status: response.status, body };
}

function abortableSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("request timeout")), timeoutMs);
  if (signal) { if (signal.aborted) controller.abort(signal.reason); else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true }); }
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

export function defaultGpuConflictProbe() {
  try {
    const tasklist = execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    if (/\bLM Studio\.exe\b/i.test(tasklist)) return { status: "CONFLICT", reason: "existing_lm_studio_process" };
  } catch { return { status: "UNAVAILABLE", reason: "gpu_probe_unavailable" }; }
  try {
    const compute = execFileSync("nvidia-smi", ["--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader,nounits"], { encoding: "utf8", windowsHide: true, timeout: 5000 }).trim();
    if (compute) return { status: "CONFLICT", reason: "existing_gpu_compute_workload" };
  } catch { return { status: "UNAVAILABLE", reason: "gpu_probe_unavailable" }; }
  return { status: "CLEAR", reason: "no_known_gpu_compute_workload" };
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
  const gpuProbe = options.gpuProbe || defaultGpuConflictProbe;
  const spawnImpl = options.spawnImpl || spawn;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = options.log || (() => {});
  let ownedProcess = null;
  let startedByAdapter = false;
  let startedViaControl = false;
  let stopping = null;

  const identity = Object.freeze({ runtime: "local", provider: "freetoken", model: config.model || "unconfigured", control_url: config.controlUrl, serve_url: config.serveUrl });
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
    if (!gate || gate.status !== "CLEAR") return { status: "BLOCKED", code: FREETOKEN_FAILURES.UNAVAILABLE, reason: gate?.reason || "GPU conflict or probe unavailable", gpu: gate || null };
    const current = await health();
    if (current.status === "READY") return { status: "READY", owned: false, health: current };
    try {
      if (config.startMode === "cli") {
        const args = ["serve", "--model-path", config.modelPath, "--host", "127.0.0.1", "--port", "1919"];
        ownedProcess = spawnImpl(options.ftCommand || "ft", args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        startedByAdapter = true;
        ownedProcess.once?.("exit", () => { ownedProcess = null; });
      } else {
        await request(`${config.controlUrl}/engine/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: config.modelPath, port: 1919, args: [] }), signal });
        startedByAdapter = true;
        startedViaControl = true;
      }
      const ready = await waitReady(signal);
      return { status: "READY", owned: startedByAdapter, ready };
    } catch (error) {
      const code = classifyFreeTokenFailure(error);
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
      const response = await request(`${config.serveUrl}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: config.model, messages: [{ role: "user", content: bounded }], max_tokens: task.max_tokens ?? 1024 }), signal: timer.signal });
      const result = { status: "PASS", response: response.body, metrics: { wall_time_ms: Date.now() - started, prompt_chars: bounded.length } };
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
