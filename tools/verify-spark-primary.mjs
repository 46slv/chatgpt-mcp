#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHttpLocalRelayAdapter } from "./devexec-closed-loop-facade.mjs";
import { parseLlamaDeviceList, parseNvidiaGpuList, resolveLlamaRuntimeDevice } from "./llamacpp-inference-adapter.mjs";
import {
  SPARK_PRIMARY_CONTEXT_LENGTH,
  SPARK_PRIMARY_DEVICE_NAME,
  SPARK_PRIMARY_MODEL,
  SPARK_PRIMARY_RELAY_URL,
  SPARK_PRIMARY_SERVE_URL,
} from "./devexec-local-defaults.mjs";

function fail(reason, details = {}) {
  process.stdout.write(`${JSON.stringify({ protocol: "devexec.spark-primary.verify", schema_version: 1, status: "BLOCKED", reason, ...details }, null, 2)}\n`);
  process.exitCode = 2;
}

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required for host verification`);
  return value;
}

function commandText(command, args) {
  return execFileSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 256 * 1024 }).trim();
}

function nvidiaSnapshot() {
  const text = commandText("nvidia-smi", ["--query-gpu=index,name,memory.used,memory.total", "--format=csv,noheader,nounits"]);
  return String(text).split(/\r?\n/).filter(Boolean).map((line) => {
    const [index, name, used, total] = line.split(",").map((value) => value.trim());
    return { index: Number(index), name, used_mib: Number(used), total_mib: Number(total) };
  }).filter((row) => Number.isInteger(row.index) && row.name);
}

function processSnapshot() {
  const script = "$p=Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('llama.exe','llama-server.exe','ollama.exe') }; @($p | ForEach-Object { [ordered]@{ pid=$_.ProcessId; name=$_.Name; command=[string]$_.CommandLine } }) | ConvertTo-Json -Compress -Depth 4";
  const raw = commandText("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function commandHas(command, fragment) {
  return String(command || "").toLowerCase().includes(String(fragment).toLowerCase());
}

async function main() {
  const command = requiredEnv("LLAMACPP_COMMAND");
  const modelPath = requiredEnv("LLAMACPP_MODEL_PATH");
  const serveUrl = String(process.env.LLAMACPP_SERVE_URL || SPARK_PRIMARY_SERVE_URL).replace(/\/$/, "");
  const expectedModel = String(process.env.LLAMACPP_MODEL || SPARK_PRIMARY_MODEL);
  const expectedDevice = String(process.env.LLAMACPP_DEVICE_NAME || SPARK_PRIMARY_DEVICE_NAME);
  const expectedContext = Number(process.env.LLAMACPP_CONTEXT || SPARK_PRIMARY_CONTEXT_LENGTH);
  if (serveUrl !== SPARK_PRIMARY_SERVE_URL) throw new Error(`standard verification requires ${SPARK_PRIMARY_SERVE_URL}`);
  if (expectedContext !== SPARK_PRIMARY_CONTEXT_LENGTH) throw new Error(`standard verification requires ${SPARK_PRIMARY_CONTEXT_LENGTH} context`);
  if (!/^Spark-X2\.5-4B-Q6_K(?:\.gguf)?$/i.test(expectedModel)) throw new Error(`unexpected Spark model identity: ${expectedModel}`);

  const beforeGpu = nvidiaSnapshot();
  const modelsResponse = await fetch(`${serveUrl}/v1/models`);
  const modelsBody = await modelsResponse.json();
  if (!modelsResponse.ok || !Array.isArray(modelsBody?.data) || modelsBody.data.length !== 1) throw new Error("/v1/models did not return one model");
  const modelId = String(modelsBody.data[0]?.id || modelsBody.data[0]?.model || modelsBody.data[0]?.name || "");
  if (!commandHas(modelId, expectedModel) && !commandHas(modelId, modelPath.split(/[\\/]/).pop())) throw new Error(`model identity readback mismatch: ${modelId}`);
  const propsResponse = await fetch(`${serveUrl}/props`);
  const propsBody = await propsResponse.json();
  const propsContext = Number(propsBody?.default_generation_settings?.n_ctx);
  if (!propsResponse.ok || propsContext !== expectedContext || !commandHas(String(propsBody?.model_path || ""), modelPath)) throw new Error("/props context/model readback mismatch");

  const relay = createHttpLocalRelayAdapter({ baseUrl: SPARK_PRIMARY_RELAY_URL, model: expectedModel });
  const payloadSha = `sha256:${"c".repeat(64)}`;
  const relayDecision = await relay.decide({ protocol: "devexec.local-relay-decision", schema_version: 1, mode: "RELAY", request_id: "spark-primary-verify", payload_sha256: payloadSha, action_expected: "FORWARD_REPORT" });

  const toolResponse = await fetch(`${serveUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "system", content: "Use a tool when external project status is required." }, { role: "user", content: "Check project status for KNOTFIELD." }],
      tools: [{ type: "function", function: { name: "get_project_status", description: "Get current project status.", parameters: { type: "object", properties: { project: { type: "string" } }, required: ["project"], additionalProperties: false } } }],
      tool_choice: "auto",
      temperature: 0,
      max_tokens: 128,
      reasoning_effort: "none",
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  const toolBody = await toolResponse.json();
  const toolCalls = toolBody?.choices?.[0]?.message?.tool_calls;
  const toolCall = Array.isArray(toolCalls) ? toolCalls.find((item) => item?.function?.name === "get_project_status") : null;
  if (!toolResponse.ok || !toolCall) throw new Error("Spark tool-call readback did not contain get_project_status");

  const runtimeText = commandText(command, ["serve", "--list-devices"]);
  const nvidiaText = commandText("nvidia-smi", ["--query-gpu=index,name", "--format=csv,noheader,nounits"]);
  const mapping = resolveLlamaRuntimeDevice(parseLlamaDeviceList(runtimeText), parseNvidiaGpuList(nvidiaText), { deviceName: expectedDevice });
  const processes = processSnapshot();
  const matching = processes.filter((item) => commandHas(item.command, modelPath) && commandHas(item.command, "--port 18080"));
  if (matching.length !== 1) throw new Error(`expected one owned Spark listener process, found ${matching.length}`);
  const processCommand = String(matching[0].command);
  const requiredFlags = ["-c 32768", "-ngl 99", "--fit off", "-fa on", "--jinja", "--host 127.0.0.1", "--split-mode none", `--main-gpu ${mapping.runtime.runtime_index}`];
  const missingFlags = requiredFlags.filter((flag) => !commandHas(processCommand, flag));
  if (missingFlags.length) throw new Error(`Spark placement command is missing: ${missingFlags.join(", ")}`);
  const afterGpu = nvidiaSnapshot();
  const qwenProcesses = processes.filter((item) => /qwen/i.test(String(item.command || "")));
  const lmsPs = (() => {
    try {
      const result = spawnSync("lms", ["ps"], { encoding: "utf8", windowsHide: true, stdio: "pipe", timeout: 10000 });
      return `${result.stdout || ""}${result.stderr || ""}`.trim();
    } catch (error) { return `ERROR:${error.message || error}`; }
  })();

  process.stdout.write(`${JSON.stringify({
    protocol: "devexec.spark-primary.verify",
    schema_version: 1,
    status: "PASS",
    routing: { runtime: "local", provider: "llamacpp", implicit_primary: true, cloud_policy: "unchanged", compatibility_fallback: "explicit-only" },
    effective: { model: expectedModel, model_readback: modelId, endpoint: SPARK_PRIMARY_RELAY_URL, api: "OpenAI-compatible /v1", context_length: expectedContext, long_context: 65536, props: { n_ctx: propsContext, model_path: propsBody.model_path, model_ftype: propsBody.model_ftype } },
    relay: { status: "PASS", model: relay.identity.model, endpoint: relay.identity.serve_url, action: relayDecision.action },
    tool_call: { status: "PASS", function: toolCall.function.name, arguments: toolCall.function.arguments || null },
    placement: { physical_name: mapping.physical.name, physical_index: mapping.physical.index, runtime_name: mapping.runtime.name, runtime_index: mapping.runtime.runtime_index, cpu_fallback: false, required_flags: requiredFlags },
    process: { pid: Number(matching[0].pid), count_on_primary_port: matching.length, command: processCommand },
    gpu: { before: beforeGpu, after: afterGpu },
    qwen_inference_processes: qwenProcesses,
    lmstudio: { lms_ps: lmsPs },
  }, null, 2)}\n`);
}

main().catch((error) => fail(String(error?.message || error)));
