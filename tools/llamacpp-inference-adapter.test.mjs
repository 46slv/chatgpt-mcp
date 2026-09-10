import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  buildLlamaServerPlan,
  createLlamaCppConfig,
  createLlamaCppInferenceAdapter,
  parseLlamaDeviceList,
  parseNvidiaGpuList,
  resolveLlamaRuntimeDevice,
  withLlamaCppChatDefaults,
} from "./llamacpp-inference-adapter.mjs";
import {
  createDevExecEntrypoint,
  DEVEXEC_PROVIDER,
  resolveDevExecRuntimeSelection,
} from "./devexec-runtime-selector.mjs";

test("llama.cpp config is explicit, loopback-only, and defaults to 32K single-device operation", () => {
  const config = createLlamaCppConfig({
    enabled: true,
    model: "Spark-X2.5-4B-Q6_K.gguf",
    modelPath: "C:\\models\\Spark-X2.5-4B-Q6_K.gguf",
  }, {});
  assert.equal(config.contextLength, 32768);
  assert.equal(config.deviceIndex, null);
  assert.equal(config.deviceName, "NVIDIA GeForce RTX 3070 Ti");
  assert.equal(config.serveUrl, "http://127.0.0.1:18080");
  assert.equal(config.disableThinking, true);
  assert.throws(() => createLlamaCppConfig({ enabled: true, modelPath: "x.gguf", serveUrl: "http://0.0.0.0:18080" }, {}), /loopback/);
});

test("runtime device mapping follows GPU identity, not nvidia-smi numeric order", () => {
  const runtime = parseLlamaDeviceList([
    "Vulkan0: NVIDIA GeForce GTX 1650 (4096 MiB)",
    "Vulkan1: NVIDIA GeForce RTX 3070 Ti (8192 MiB)",
  ].join("\n"));
  const nvidia = parseNvidiaGpuList([
    "0, NVIDIA GeForce RTX 3070 Ti",
    "1, NVIDIA GeForce GTX 1650",
  ].join("\n"));
  const selected = resolveLlamaRuntimeDevice(runtime, nvidia, 0);
  assert.equal(selected.physical.name, "NVIDIA GeForce RTX 3070 Ti");
  assert.equal(selected.runtime.runtime_index, 1);
});

test("server plan preserves the verified fail-closed Spark lane", () => {
  const config = createLlamaCppConfig({
    enabled: true,
    command: "llama",
    model: "Spark-X2.5-4B-Q6_K.gguf",
    modelPath: "C:\\models\\Spark-X2.5-4B-Q6_K.gguf",
    contextLength: 32768,
    serveUrl: "http://127.0.0.1:18080",
  }, {});
  const plan = buildLlamaServerPlan(config, 1);
  assert.equal(plan.args[0], "serve");
  assert.deepEqual(plan.args.slice(plan.args.indexOf("--fit"), plan.args.indexOf("--fit") + 2), ["--fit", "off"]);
  assert.deepEqual(plan.args.slice(plan.args.indexOf("--split-mode"), plan.args.indexOf("--split-mode") + 2), ["--split-mode", "none"]);
  assert.deepEqual(plan.args.slice(plan.args.indexOf("--main-gpu"), plan.args.indexOf("--main-gpu") + 2), ["--main-gpu", "1"]);
  assert.deepEqual(plan.args.slice(plan.args.indexOf("-c"), plan.args.indexOf("-c") + 2), ["-c", "32768"]);
});

test("Spark chat requests disable thinking explicitly without discarding existing template kwargs", () => {
  const adjusted = withLlamaCppChatDefaults("http://127.0.0.1:18080/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "spark", messages: [], chat_template_kwargs: { custom: 1 } }),
  });
  const body = JSON.parse(adjusted.body);
  assert.equal(body.chat_template_kwargs.enable_thinking, false);
  assert.equal(body.chat_template_kwargs.custom, 1);
});

test("matching external Spark llama.cpp server is reusable and does not trigger a GPU-conflict probe", async () => {
  let gpuChecks = 0;
  const adapter = createLlamaCppInferenceAdapter({
    env: {},
    config: {
      enabled: true,
      model: "Spark-X2.5-4B-Q6_K.gguf",
      modelPath: "C:\\models\\Spark-X2.5-4B-Q6_K.gguf",
    },
    gpuProbe: () => { gpuChecks += 1; return { status: "CONFLICT" }; },
    request: async () => ({ status: 200, body: { data: [{ id: "Spark-X2.5-4B-Q6_K.gguf" }] } }),
    execFileSyncImpl: (command, args) => {
      if (command === "nvidia-smi") return "0, NVIDIA GeForce RTX 3070 Ti\n1, NVIDIA GeForce GTX 1650\n";
      assert.equal(command, "llama");
      assert.deepEqual(args, ["serve", "--list-devices"]);
      return "Vulkan0: NVIDIA GeForce GTX 1650 (4096 MiB)\nVulkan1: NVIDIA GeForce RTX 3070 Ti (8192 MiB)\n";
    },
  });
  const gate = await adapter.gpuGate();
  assert.equal(gate.status, "CLEAR");
  assert.equal(gpuChecks, 0);
});

test("owned llama.cpp startup maps the physical RTX to the runtime index and cleanup touches only that child", async () => {
  const requests = [];
  let requestCount = 0;
  let killed = null;
  let spawned = null;
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const adapter = createLlamaCppInferenceAdapter({
    config: {
      enabled: true,
      command: "llama",
      model: "Spark-X2.5-4B-Q6_K.gguf",
      modelPath: process.execPath,
      serveUrl: "http://127.0.0.1:18080",
      readyTimeoutMs: 1000,
    },
    request: async (url, options) => {
      requests.push({ url, options });
      requestCount += 1;
      if (requestCount === 1) throw new Error("ECONNREFUSED");
      return { status: 200, body: { data: [{ id: "Spark-X2.5-4B-Q6_K.gguf" }] } };
    },
    gpuProbe: () => ({ status: "CLEAR" }),
    execFileSyncImpl: (command, args) => {
      if (command === "nvidia-smi") return "0, NVIDIA GeForce RTX 3070 Ti\n1, NVIDIA GeForce GTX 1650\n";
      assert.equal(command, "llama");
      assert.deepEqual(args, ["serve", "--list-devices"]);
      return "Vulkan0: NVIDIA GeForce GTX 1650 (4096 MiB)\nVulkan1: NVIDIA GeForce RTX 3070 Ti (8192 MiB)\n";
    },
    spawnImpl: (command, args) => { spawned = { command, args }; return child; },
    killProcessTree: (value) => { killed = value; return true; },
    sleep: async () => {},
  });
  const started = await adapter.start();
  assert.equal(started.status, "READY");
  assert.equal(spawned.command, "llama");
  assert.deepEqual(spawned.args.slice(spawned.args.indexOf("--main-gpu"), spawned.args.indexOf("--main-gpu") + 2), ["--main-gpu", "1"]);
  await adapter.stop();
  assert.equal(killed, child);
});

test("Dev Exec selection exposes Spark llama.cpp as the implicit local provider", async () => {
  assert.deepEqual(
    resolveDevExecRuntimeSelection({ runtime: "local", provider: "llamacpp", enabled: true }),
    { runtime: "local", provider: "llamacpp", explicit: true, enabled: true },
  );
  assert.equal(DEVEXEC_PROVIDER.LLAMA_CPP, "llamacpp");
  const fake = {
    identity: { runtime: "local", provider: "llamacpp", model: "spark" },
    config: { idleStopMs: 0, deviceIndex: 0, model: "spark", serveUrl: "http://127.0.0.1:18080" },
    async run() { return { status: "PASS" }; },
    async health() { return { status: "READY" }; },
  };
  const entry = createDevExecEntrypoint({
    selection: { runtime: "local", provider: "llamacpp", enabled: true },
    adapters: { llamacpp: fake },
  });
  assert.equal(entry.identity.provider, "llamacpp");
  assert.deepEqual(await entry.health(), { status: "READY" });
  const existing = { async run(value) { return value; } };
  const defaultEntry = createDevExecEntrypoint({ env: {}, adapters: { default: existing } });
  assert.deepEqual(defaultEntry.selection, { runtime: "local", provider: "llamacpp", explicit: false, enabled: true });
});
