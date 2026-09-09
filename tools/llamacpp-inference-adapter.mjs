import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import {
  createFreeTokenInferenceAdapter,
  defaultGpuConflictProbe,
  killOwnedProcessTree,
  logicalModelId,
  FREETOKEN_FAILURES,
} from "./freetoken-inference-adapter.mjs";

export const LLAMACPP_DEFAULT_SERVE_URL = "http://127.0.0.1:18080";
export const LLAMACPP_FAILURES = FREETOKEN_FAILURES;

function boundedString(value, name, max = 4096) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} must be a bounded string`);
  return value.trim();
}

function boundedInteger(value, fallback, min, max, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    if (value === undefined || value === null || value === "") return fallback;
    throw new Error(`${name} must be an integer`);
  }
  if (parsed < min || parsed > max) throw new Error(`${name} outside safe bounds`);
  return parsed;
}

function loopbackUrl(value, name) {
  const normalized = boundedString(String(value), name, 256).replace(/\/$/, "");
  let parsed;
  try { parsed = new URL(normalized); } catch { throw new Error(`${name} must be a valid loopback URL`); }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error(`${name} must use loopback HTTP`);
  if (!parsed.port) throw new Error(`${name} must include an explicit port`);
  return normalized;
}

function modelNames(value) {
  if (typeof value !== "string" || !value.trim()) return [];
  const text = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const basename = text.split("/").pop();
  return [...new Set([text.toLowerCase(), basename?.toLowerCase()].filter(Boolean))];
}

function entryNames(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
  return [entry.id, entry.model, entry.name, entry.model_name]
    .filter((value) => typeof value === "string" && value.trim())
    .flatMap(modelNames);
}

export function createLlamaCppConfig(input = {}, env = process.env) {
  const enabled = input.enabled ?? (env.LLAMACPP_ENABLED === "1");
  if (typeof enabled !== "boolean") throw new Error("enabled must be boolean");
  const modelPath = input.modelPath ?? env.LLAMACPP_MODEL_PATH ?? "";
  const model = input.model ?? env.LLAMACPP_MODEL ?? (modelPath ? logicalModelId(String(modelPath), "spark-x2.5-4b-q6_k") : "spark-x2.5-4b-q6_k");
  const command = input.command ?? env.LLAMACPP_COMMAND ?? "llama";
  const serveUrl = loopbackUrl(input.serveUrl ?? env.LLAMACPP_SERVE_URL ?? LLAMACPP_DEFAULT_SERVE_URL, "serveUrl");
  const contextLength = boundedInteger(input.contextLength ?? env.LLAMACPP_CONTEXT ?? 32768, 32768, 1024, 1_048_576, "contextLength");
  const deviceIndex = boundedInteger(input.deviceIndex ?? env.LLAMACPP_DEVICE_INDEX ?? 0, 0, 0, 16, "deviceIndex");
  const readyTimeoutMs = boundedInteger(input.readyTimeoutMs ?? env.LLAMACPP_READY_TIMEOUT_MS ?? 300000, 300000, 1000, 600000, "readyTimeoutMs");
  const inferenceRequestTimeoutMs = boundedInteger(input.inferenceRequestTimeoutMs ?? env.LLAMACPP_INFERENCE_REQUEST_TIMEOUT_MS ?? 180000, 180000, 1000, 600000, "inferenceRequestTimeoutMs");
  const requestTimeoutMs = boundedInteger(input.requestTimeoutMs ?? env.LLAMACPP_REQUEST_TIMEOUT_MS ?? 10000, 10000, 500, 120000, "requestTimeoutMs");
  const idleStopMs = boundedInteger(input.idleStopMs ?? 0, 0, 0, 120000, "idleStopMs");
  const disableThinking = input.disableThinking ?? true;
  if (typeof disableThinking !== "boolean") throw new Error("disableThinking must be boolean");
  if (enabled) {
    boundedString(String(modelPath), "modelPath", 4096);
    boundedString(String(model), "model", 1024);
    boundedString(String(command), "command", 4096);
  }
  return Object.freeze({
    enabled,
    model: String(model),
    modelPath: String(modelPath),
    command: String(command),
    serveUrl,
    contextLength,
    deviceIndex,
    readyTimeoutMs,
    inferenceRequestTimeoutMs,
    requestTimeoutMs,
    idleStopMs,
    disableThinking,
  });
}

export function parseLlamaDeviceList(text) {
  const devices = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^\s*(\S+):\s+(.+?)\s+\((.+)\)\s*$/);
    if (!match) continue;
    const index = match[1].match(/(\d+)$/);
    devices.push({ id: match[1], name: match[2].trim(), details: match[3].trim(), runtime_index: index ? Number(index[1]) : null });
  }
  return devices;
}

export function parseNvidiaGpuList(text) {
  const rows = [];
  for (const line of String(text || "").split(/\r?\n/).filter(Boolean)) {
    const parts = line.split(",").map((value) => value.trim());
    if (parts.length < 2) continue;
    const index = Number(parts[0]);
    if (!Number.isInteger(index)) continue;
    rows.push({ index, name: parts[1] });
  }
  return rows;
}

function sameGpuName(a, b) {
  const left = String(a || "").trim().toLowerCase();
  const right = String(b || "").trim().toLowerCase();
  return !!left && !!right && (left === right || left.includes(right) || right.includes(left));
}

export function resolveLlamaRuntimeDevice(runtimeDevices, nvidiaGpus, deviceIndex = 0) {
  const physical = nvidiaGpus.find((gpu) => gpu.index === deviceIndex);
  if (!physical) throw new Error(`nvidia-smi device ${deviceIndex} is unavailable`);
  const runtime = runtimeDevices.find((device) => sameGpuName(device.name, physical.name));
  if (!runtime || !Number.isInteger(runtime.runtime_index)) throw new Error(`could not map NVIDIA GPU '${physical.name}' to llama.cpp runtime device`);
  return Object.freeze({ physical, runtime });
}

function combinedCommand(command) {
  const base = path.basename(String(command)).toLowerCase();
  return !/^llama-server(?:\.exe)?$/.test(base);
}

export function buildLlamaServerPlan(configInput, runtimeIndex) {
  const config = configInput?.serveUrl ? configInput : createLlamaCppConfig(configInput, {});
  const url = new URL(config.serveUrl);
  const args = [];
  if (combinedCommand(config.command)) args.push("serve");
  args.push(
    "-m", config.modelPath,
    "-c", String(config.contextLength),
    "-ngl", "99",
    "--fit", "off",
    "-fa", "on",
    "--jinja",
    "--port", url.port,
    "--host", url.hostname === "localhost" ? "127.0.0.1" : url.hostname,
    "--split-mode", "none",
    "--main-gpu", String(runtimeIndex),
  );
  return Object.freeze({ command: config.command, args });
}

export function withLlamaCppChatDefaults(url, options = {}, disableThinking = true) {
  if (!disableThinking || !String(url).endsWith("/v1/chat/completions") || typeof options.body !== "string") return options;
  let body;
  try { body = JSON.parse(options.body); } catch { return options; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return options;
  return {
    ...options,
    body: JSON.stringify({
      ...body,
      chat_template_kwargs: { ...(body.chat_template_kwargs || {}), enable_thinking: false },
    }),
  };
}

function matchingModel(body, config) {
  if (!body || typeof body !== "object" || !Array.isArray(body.data) || !body.data.length) return null;
  const expected = [...new Set([...modelNames(config.model), ...modelNames(config.modelPath)])];
  const entry = body.data.find((candidate) => entryNames(candidate).some((name) => expected.includes(name)));
  if (!entry) return null;
  return String(entry.id || entry.model || entry.name || config.model);
}

function failure(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function classifyStartFailure(text) {
  const lower = String(text || "").toLowerCase();
  if (/out of memory|vkallocatememory|failed to allocate|not enough.*memory/.test(lower)) return FREETOKEN_FAILURES.GPU_OOM;
  if (/unknown model architecture|unsupported.*architecture|architecture.*not supported/.test(lower)) return FREETOKEN_FAILURES.MODEL_LOAD_FAILURE;
  if (/address already in use|eaddrinuse|port.*in use/.test(lower)) return FREETOKEN_FAILURES.PORT_COLLISION;
  return FREETOKEN_FAILURES.SERVER_FAILURE;
}

async function defaultRequest(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { text: text.slice(0, 4000) }; }
  if (!response.ok) throw failure(FREETOKEN_FAILURES.SERVER_FAILURE, `llama.cpp HTTP ${response.status}`, { status: response.status, body });
  return { status: response.status, body };
}

export function createLlamaCppInferenceAdapter(options = {}) {
  const config = createLlamaCppConfig(options.config || options, options.env || process.env);
  const requestImpl = options.request || defaultRequest;
  const execFileSyncImpl = options.execFileSyncImpl || execFileSync;
  const spawnImpl = options.spawnImpl || spawn;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const gpuProbe = options.gpuProbe || (() => defaultGpuConflictProbe(config.deviceIndex, { execFileSyncImpl }));
  const killProcessTree = options.killProcessTree || ((child) => killOwnedProcessTree(child, options));
  const log = options.log || (() => {});
  let ownedProcess = null;
  let owned = false;
  let stderrTail = "";
  let stdoutTail = "";

  const identity = Object.freeze({
    runtime: "local",
    provider: "llamacpp",
    model: logicalModelId(config.model || config.modelPath, "unconfigured"),
    device_index: config.deviceIndex,
    serve_url: config.serveUrl,
  });

  async function request(url, requestOptions = {}) {
    const adjusted = withLlamaCppChatDefaults(url, requestOptions, config.disableThinking);
    return requestImpl(url, adjusted);
  }

  async function health(signal = null) {
    if (!config.enabled) return { status: "DISABLED", code: FREETOKEN_FAILURES.DISABLED, owned: false };
    try {
      const result = await request(`${config.serveUrl}/v1/models`, { method: "GET", signal });
      const modelId = matchingModel(result.body, config);
      if (modelId) return { status: "READY", code: null, owned, model_id: modelId, serve: result.body };
      if (result?.body?.data?.length) return { status: "CONFLICT", code: FREETOKEN_FAILURES.PORT_COLLISION, owned: false, reason: "serve_port_has_different_model", serve: result.body };
      return { status: "NOT_READY", code: null, owned: false, reason: "configured_model_not_advertised" };
    } catch (error) {
      if (signal?.aborted) return { status: "CANCELLED", code: FREETOKEN_FAILURES.CANCELLED, owned: false };
      return { status: "UNAVAILABLE", code: FREETOKEN_FAILURES.UNAVAILABLE, owned: false, reason: String(error?.message || error) };
    }
  }

  function runtimeDevice() {
    const nvidiaText = execFileSyncImpl("nvidia-smi", ["--query-gpu=index,name", "--format=csv,noheader,nounits"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    const listArgs = combinedCommand(config.command) ? ["serve", "--list-devices"] : ["--list-devices"];
    const llamaText = execFileSyncImpl(config.command, listArgs, { encoding: "utf8", windowsHide: true, timeout: 15000 });
    return resolveLlamaRuntimeDevice(parseLlamaDeviceList(llamaText), parseNvidiaGpuList(nvidiaText), config.deviceIndex);
  }

  async function waitReady(signal = null) {
    const deadline = Date.now() + config.readyTimeoutMs;
    let last = null;
    while (Date.now() <= deadline) {
      if (signal?.aborted) throw failure(FREETOKEN_FAILURES.CANCELLED, "llama.cpp readiness cancelled");
      if (ownedProcess?.exitCode !== null && ownedProcess?.exitCode !== undefined) {
        throw failure(classifyStartFailure(`${stdoutTail}\n${stderrTail}`), `llama.cpp server exited before ready (${ownedProcess.exitCode})`);
      }
      try {
        const state = await health(signal);
        if (state.status === "READY") return state;
        if (state.status === "CONFLICT") throw failure(FREETOKEN_FAILURES.PORT_COLLISION, state.reason);
        last = state.reason || state.status;
      } catch (error) { last = error; }
      await sleep(250);
    }
    const code = classifyStartFailure(`${stdoutTail}\n${stderrTail}`);
    throw failure(code === FREETOKEN_FAILURES.SERVER_FAILURE ? FREETOKEN_FAILURES.TIMEOUT : code, "llama.cpp readiness timeout", { cause: String(last?.message || last || "") });
  }

  async function start({ signal } = {}) {
    if (!config.enabled) return { status: "BLOCKED", code: FREETOKEN_FAILURES.DISABLED, reason: "provider disabled" };
    const current = await health(signal);
    if (current.status === "READY") return { status: "READY", owned: false, model_id: current.model_id, health: current };
    if (current.status === "CONFLICT") return { status: "BLOCKED", code: FREETOKEN_FAILURES.PORT_COLLISION, reason: current.reason, health: current };
    const gate = await Promise.resolve(gpuProbe());
    if (!gate || gate.status !== "CLEAR") {
      return { status: "BLOCKED", code: gate?.status === "CONFLICT" ? FREETOKEN_FAILURES.GPU_CONFLICT : FREETOKEN_FAILURES.UNAVAILABLE, reason: gate?.reason || "target GPU unavailable", gpu: gate || null };
    }
    if (!fs.existsSync(config.modelPath) || !fs.statSync(config.modelPath).isFile()) return { status: "BLOCKED", code: FREETOKEN_FAILURES.MODEL_LOAD_FAILURE, reason: "configured GGUF model file is unavailable" };
    let mapping;
    try { mapping = runtimeDevice(); }
    catch (error) { return { status: "BLOCKED", code: FREETOKEN_FAILURES.UNAVAILABLE, reason: String(error?.message || error) }; }
    const plan = buildLlamaServerPlan(config, mapping.runtime.runtime_index);
    stderrTail = "";
    stdoutTail = "";
    try {
      ownedProcess = spawnImpl(plan.command, plan.args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      owned = true;
      const append = (currentText, chunk) => `${currentText}${String(chunk || "")}`.slice(-16000);
      ownedProcess.stdout?.on?.("data", (chunk) => { stdoutTail = append(stdoutTail, chunk); });
      ownedProcess.stderr?.on?.("data", (chunk) => { stderrTail = append(stderrTail, chunk); });
      const child = ownedProcess;
      child.once?.("exit", () => { if (ownedProcess === child && child.exitCode !== null) log({ event: "llamacpp_exit", exit_code: child.exitCode }); });
      const ready = await waitReady(signal);
      return { status: "READY", owned: true, model_id: ready.model_id, device: mapping, plan: { command: path.basename(plan.command), args: plan.args.map((arg, i) => plan.args[i - 1] === "-m" ? "[MODEL_PATH]" : arg) } };
    } catch (error) {
      const code = error?.code && Object.values(FREETOKEN_FAILURES).includes(error.code) ? error.code : classifyStartFailure(`${stdoutTail}\n${stderrTail}\n${error?.message || error}`);
      await stop();
      return { status: "BLOCKED", code, reason: String(error?.message || error) };
    }
  }

  async function gpuGate(signal = null) {
    const current = await health(signal);
    if (current.status === "READY") return { status: "CLEAR", reason: "matching_llamacpp_server_ready", device_index: config.deviceIndex };
    if (current.status === "CONFLICT") return { status: "CONFLICT", code: FREETOKEN_FAILURES.PORT_COLLISION, reason: current.reason, device_index: config.deviceIndex };
    return Promise.resolve(gpuProbe());
  }

  async function stop() {
    if (ownedProcess && owned) {
      killProcessTree(ownedProcess);
      ownedProcess = null;
    }
    owned = false;
    return { status: "STOPPED" };
  }

  function innerAdapter(modelId) {
    const url = new URL(config.serveUrl);
    const servePort = Number(url.port);
    const controlPort = servePort === 1900 ? 1901 : 1900;
    const controlUrl = `http://127.0.0.1:${controlPort}`;
    return createFreeTokenInferenceAdapter({
      config: {
        enabled: true,
        model: modelId,
        modelPath: config.modelPath,
        serveUrl: config.serveUrl,
        controlUrl,
        deviceIndex: config.deviceIndex,
        readyTimeoutMs: config.readyTimeoutMs,
        requestTimeoutMs: config.requestTimeoutMs,
        inferenceRequestTimeoutMs: config.inferenceRequestTimeoutMs,
        idleStopMs: 0,
      },
      gpuProbe: () => ({ status: "CLEAR", reason: "llamacpp_wrapper_owns_gpu_gate" }),
      request: async (urlValue, requestOptions) => {
        if (String(urlValue).startsWith(controlUrl)) throw new Error("ECONNREFUSED");
        return request(urlValue, requestOptions);
      },
      sleep,
      log: (event) => log({ ...event, provider: "llamacpp" }),
    });
  }

  async function run(task, context = {}) {
    if (!config.enabled) return { status: "BLOCKED", code: FREETOKEN_FAILURES.DISABLED, reason: "provider disabled" };
    context.onLifecycle?.("start_start");
    const lifecycle = await start({ signal: context.signal });
    context.onLifecycle?.("start_end");
    if (lifecycle.status !== "READY") return lifecycle;
    context.onLifecycle?.("ready_start");
    context.onLifecycle?.("ready_end");
    try {
      context.onLifecycle?.("inference_start");
      const inner = innerAdapter(lifecycle.model_id);
      const result = await inner.run(task, { ...context, onLifecycle: undefined });
      return { ...result, metrics: { ...(result.metrics || {}), provider: "llamacpp", context_length: config.contextLength } };
    } finally {
      context.onLifecycle?.("inference_end");
      context.onLifecycle?.("cleanup_start");
      if (config.idleStopMs === 0) await stop();
      else setTimeout(() => { void stop(); }, config.idleStopMs).unref?.();
      context.onLifecycle?.("cleanup_end");
    }
  }

  return Object.freeze({ identity, config, health, start, run, stop, waitReady, gpuGate });
}

export default createLlamaCppInferenceAdapter;
