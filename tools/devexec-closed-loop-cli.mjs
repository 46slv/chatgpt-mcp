#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_CLOSED_LOOP_ADMISSION_ROOT,
  DEFAULT_LOCAL_RELAY_URL,
  DEFAULT_MCP_CONFIG_PATH,
  admitExistingCodexTask,
  closedLoopAdmissionPath,
  loadClosedLoopAdmission,
  runAdmittedClosedLoop,
} from "./devexec-closed-loop-facade.mjs";
import { createClosedLoopStateStore } from "./devexec-closed-loop.mjs";

const HELP = [
  "Usage:",
  " devexec closed-loop admit --mission-id <id> --task-id <id> --thread-id <uuid> --initial-turn-id <uuid>",
  "   --chat-url <exact canonical URL> --runtime-path <absolute codex.exe>",
  "   --working-directory <absolute path> [--repo-root <absolute path>]",
  "   [--admission <id>] [--admission-root <absolute path>] [--state-dir <absolute path>]",
  "   [--max-rounds <1..20>] [--turn-timeout-ms <ms>] [--chatgpt-timeout-ms <ms>] [--local-relay-timeout-ms <ms>]",
  " devexec closed-loop run --admission <id-or-absolute-manifest-path>",
  "   [--admission-root <absolute path>] [--relay-url <loopback URL>] [--relay-model <id>] [--mcp-config <absolute path>]",
  " devexec closed-loop inspect --admission <id-or-absolute-manifest-path> [--admission-root <absolute path>]",
  "",
  "Admission and continuation are exact and parent-owned. No target alias, current chat, default target, PATH, --last, or fuzzy session fallback is available.",
].join("\n");

const VALUE_OPTIONS = new Set([
  "mission-id",
  "task-id",
  "thread-id",
  "initial-turn-id",
  "chat-url",
  "runtime-path",
  "working-directory",
  "repo-root",
  "admission",
  "admission-root",
  "state-dir",
  "max-rounds",
  "turn-timeout-ms",
  "chatgpt-timeout-ms",
  "local-relay-timeout-ms",
  "relay-url",
  "relay-model",
  "mcp-config",
]);

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    if (!VALUE_OPTIONS.has(name)) throw new Error(`Unknown closed-loop argument: ${token}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${token} requires a value.`);
    values[name] = value;
    index += 1;
  }
  return values;
}

function required(values, name) {
  const value = values[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`--${name} is required.`);
  return value;
}

function integer(values, name, fallback = undefined) {
  const raw = values[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`--${name} must be an integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`--${name} is out of range.`);
  return value;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function admissionRoot(values) {
  return values["admission-root"] || process.env.DEV_EXEC_CLOSED_LOOP_ADMISSION_DIR || DEFAULT_CLOSED_LOOP_ADMISSION_ROOT;
}

async function admit(values) {
  const result = await admitExistingCodexTask({
    mission_id: required(values, "mission-id"),
    task_id: required(values, "task-id"),
    thread_id: required(values, "thread-id"),
    initial_turn_id: required(values, "initial-turn-id"),
    chat_url: required(values, "chat-url"),
    runtime_path: required(values, "runtime-path"),
    working_directory: required(values, "working-directory"),
    repo_root: values["repo-root"],
    admission_id: values.admission,
    admission_root: admissionRoot(values),
    state_dir: values["state-dir"],
    max_rounds: integer(values, "max-rounds", 8),
    turn_timeout_ms: integer(values, "turn-timeout-ms"),
    chatgpt_timeout_ms: integer(values, "chatgpt-timeout-ms"),
    local_relay_timeout_ms: integer(values, "local-relay-timeout-ms"),
    runtime_provenance: "explicit-cli-runtime",
  });
  print({
    command: "closed-loop admit",
    created: result.created,
    admission_id: result.admission.admission_id,
    manifest: result.file,
    mission_id: result.admission.mission_id,
    task_id: result.admission.task_id,
    thread_identity: result.thread_identity,
    task_chat_binding_id: result.admission.task_chat_binding.binding_id,
    codex_continuation_binding_id: result.admission.codex_continuation_binding.binding_id,
    codex_runtime_binding_id: result.admission.codex_runtime_binding.binding_id,
    limits: result.admission.limits,
  });
}

async function run(values) {
  const result = await runAdmittedClosedLoop({
    admissionReference: required(values, "admission"),
    admissionRoot: admissionRoot(values),
    relayUrl: values["relay-url"] || process.env.DEV_EXEC_LOCAL_RELAY_URL || DEFAULT_LOCAL_RELAY_URL,
    relayModel: values["relay-model"] || process.env.DEV_EXEC_LOCAL_RELAY_MODEL || "qwen/qwen3.5-4b",
    mcpConfigPath: values["mcp-config"] || process.env.DEV_EXEC_MCP_CONFIG || DEFAULT_MCP_CONFIG_PATH,
  });
  print({
    command: "closed-loop run",
    admission_id: result.admission.admission_id,
    result: result.result,
    evidence: result.evidence,
    state_file: path.join(result.admission.state_dir, "loops-v1"),
  });
  if (["DELIVERY_UNKNOWN", "REJECTED", "CANCELLED"].includes(result.result.status)) process.exitCode = 3;
  else if (result.result.status === "NEEDS_HUMAN") process.exitCode = 2;
}

function inspect(values) {
  const admission = loadClosedLoopAdmission(required(values, "admission"), { admissionRoot: admissionRoot(values) });
  let state = null;
  try {
    const store = createClosedLoopStateStore({ stateDir: admission.state_dir });
    state = store.load(admission.loop_id);
  } catch (error) {
    state = { status: "UNREADABLE", error: String(error.message || error) };
  }
  print({ command: "closed-loop inspect", admission, state });
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv.shift();
  const subcommand = command === "closed-loop" ? argv.shift() : command;
  if ((command !== "closed-loop" && !["admit", "run", "inspect", "help", "--help"].includes(command)) || !subcommand || subcommand === "help" || subcommand === "--help") {
    process.stdout.write(`${HELP}\n`);
    if (subcommand === "help" || subcommand === "--help") return 0;
    return command === "closed-loop" ? 2 : 0;
  }
  const values = parseArgs(argv);
  if (subcommand === "admit") await admit(values);
  else if (subcommand === "run") await run(values);
  else if (subcommand === "inspect") inspect(values);
  else throw new Error(`Unknown closed-loop subcommand: ${subcommand}`);
  return process.exitCode || 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`[devexec closed-loop] ${error.code || "ERROR"}: ${error.message || error}\n`);
    process.exitCode = 1;
  });
}
