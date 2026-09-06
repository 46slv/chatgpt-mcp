#!/usr/bin/env node
// devexec-relay.mjs — thin single-use relay entrypoint (exactly one round trip).
//
//   node tools/devexec-relay.mjs once --thread <uuid> --target <alias> --report <text|--report-file path> [options]
//   node tools/devexec-relay.mjs status --state-dir <dir>
//
// Reuses only source-owned seams (target registry, TaskChatBinding,
// CodexContinuationSender/Return, RuntimeBinding, validateCodexPromptResponse,
// blockingReply transport) plus the thin roundtrip wrapper. No loop, no
// scheduler, no Local Model gate, no new state machine or dedupe: sequencing
// is enforced by artifact presence and exclusive-claim files, so rerunning
// `once` after a partial run resumes without ever resending or reinjecting.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { resolveTarget } from "./target-registry.mjs";
import {
  buildCanaryChatGPTPayload,
  buildCodexReturnText,
  claimChatGPTSendSlot,
  createCanaryBindings,
  createCanaryCodexReturn,
  createCanaryCodexSender,
  createCanaryRuntimeBinding,
  sha256Digest,
  validateCanaryContinue,
  writeEvidenceReceipt,
} from "./devexec-roundtrip-relay.mjs";

const ART = Object.freeze({
  bindings: "bindings.json",
  report: "report.json",
  payload: "payload.txt",
  slot: "send-slot.json",
  response: "response.txt",
  anchor: "anchor.json",
  ret: "return.json",
  attempt: "return-attempt.json",
  evidence: "evidence.json",
});

function fail(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

function parseArgs(argv) {
  const output = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) output[key] = true;
      else { output[key] = next; index += 1; }
    } else output._.push(token);
  }
  return output;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`Cannot read ${filePath}: ${error.message}`);
  }
}

function writeNew(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(filePath, text, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") fail(`Already exists (single-use guard): ${filePath}`, 2);
    throw error;
  }
}

export function defaultStateDir(requestId) {
  const base = process.env.LOCALAPPDATA || process.env.HOME || ".";
  return path.join(String(base), "ChatGPTMCPProbe", "relay-once", String(requestId));
}

// Source-owned alias resolution: never a raw fallback, default, or current-chat.
export function resolveRelayTarget(alias, resolver = resolveTarget) {
  if (typeof alias !== "string" || alias.length === 0) fail("Missing --target <registered-alias>.");
  const resolved = resolver({ explicitTarget: alias });
  if (!resolved?.chat_url || !resolved?.conversation_id) fail(`Target alias did not resolve to an exact conversation: ${alias}.`);
  return resolved;
}

async function liveChatGPTTransport({ payload, chat_url, conversation_id }) {
  let mod = null;
  for (const spec of ["../dist/chatgpt.js", "./chatgpt.js"]) {
    try { mod = await import(spec); break; } catch {}
  }
  if (!mod?.blockingReply) fail("Live ChatGPT transport unavailable (run npm run build first).");
  return mod.blockingReply(payload, 30, { target_url: chat_url, expected_conversation_id: conversation_id });
}

function pwshCodexInvoke(timeoutMs = 0) {
  return ({ command, args, cwd }) => new Promise((resolve, reject) => {
    const child = spawn("pwsh.exe", ["-NoProfile", "-File", command, ...args], { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill(); } catch {}
        reject(Object.assign(new Error(`Codex continuation timed out after ${timeoutMs}ms; outcome unknown, reinjection forbidden.`), { code: "CONTINUATION_DELIVERY_UNKNOWN" }));
      }, timeoutMs);
      timer.unref?.();
    }
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ exitCode: Number.isInteger(code) ? code : -1, stdout, stderr });
    });
  });
}

export async function runOnce(options = {}) {
  const thread_id = String(options.thread ?? options.thread_id ?? fail("Missing --thread <exact-thread-uuid>."));
  const alias = String(options.target ?? fail("Missing --target <registered-alias>."));
  const stateDir = String(options.state_dir ?? options.stateDir ?? defaultStateDir(options.request_id ?? options.requestId ?? `relay-${Date.now().toString(36)}`));
  const transport = options.transport ?? liveChatGPTTransport;
  const invoke = options.invoke ?? pwshCodexInvoke(Number(options.timeout_ms ?? options.timeoutMs ?? 0));
  const targetResolver = options.targetResolver ?? resolveTarget;

  const summary = { state_dir: stateDir, resent_chatgpt: false, reinjected_codex: false };
  const F = (name) => path.join(stateDir, ART[name]);

  // Step 1: bindings (exclusive; rerun reuses).
  let bindings;
  if (!fs.existsSync(F("bindings"))) {
    const mission_id = String(options.mission ?? options.mission_id ?? "devexec-relay");
    const task_id = String(options.task ?? options.task_id ?? "relay-once");
    const working_directory = String(options.cwd ?? options.working_directory ?? process.cwd());
    const resolved = resolveRelayTarget(alias, targetResolver);
    const built = createCanaryBindings({
      mission_id, task_id, thread_id, working_directory,
      ...(options.repo === undefined ? {} : { repo_root: String(options.repo) }),
      chat_url: resolved.chat_url,
    });
    bindings = {
      mission_id, task_id, thread_id, working_directory,
      repo_root: options.repo === undefined ? null : String(options.repo),
      target_alias: resolved.target_id ?? alias,
      chat_url: built.taskChatBinding.chat_url,
      conversation_id: built.taskChatBinding.conversation_id,
      task_chat_binding_id: built.taskChatBinding.binding_id,
      codex_continuation_binding_id: built.continuationBinding.binding_id,
      nonce: String(options.nonce ?? Date.now().toString(36)),
      relay_request_id: String(options.request_id ?? options.requestId ?? `relay-${Date.now().toString(36)}`),
      created_at: new Date().toISOString(),
    };
    writeNew(F("bindings"), `${JSON.stringify(bindings, null, 2)}\n`);
  } else {
    bindings = readJson(F("bindings"));
    if (bindings.thread_id !== thread_id) fail("State dir is bound to a different thread; refusing to cross-route.", 4);
    const resolved = resolveRelayTarget(alias, targetResolver);
    if (resolved.chat_url !== bindings.chat_url || resolved.conversation_id !== bindings.conversation_id) {
      fail("Registered target drifted since admission; refusing to send elsewhere.", 4);
    }
  }
  summary.relay_request_id = bindings.relay_request_id;

  // Step 2: report + payload (exclusive).
  if (!fs.existsSync(F("report"))) {
    let report = options.report ?? options.report_text;
    if (report === undefined && options.report_file !== undefined) report = fs.readFileSync(String(options.report_file), "utf8");
    if (typeof report !== "string" || report.trim().length === 0) fail("Missing --report <text> or --report-file <path>.");
    const report_sha256 = sha256Digest(report);
    writeNew(F("report"), `${JSON.stringify({ report, report_sha256 }, null, 2)}\n`);
    const payload = buildCanaryChatGPTPayload({
      report, relay_request_id: bindings.relay_request_id, report_sha256,
      nonce: bindings.nonce, mission_id: bindings.mission_id, task_id: bindings.task_id,
      headline: "This is a Dev Exec relay.",
      ...(options.instruct === undefined
        ? (options.expect === undefined ? {} : { expect: String(options.expect) })
        : { instruction: String(options.instruct) }),
    });
    writeNew(F("payload"), payload);
  }
  const { report_sha256 } = readJson(F("report"));
  const payload = fs.readFileSync(F("payload"), "utf8");

  // Step 3: single ChatGPT send (exclusive claim; rerun skips when response exists).
  if (!fs.existsSync(F("response"))) {
    claimChatGPTSendSlot(F("slot"), { relay_request_id: bindings.relay_request_id, payload });
    let result;
    try {
      result = await transport({ payload, chat_url: bindings.chat_url, conversation_id: bindings.conversation_id });
    } catch (error) {
      fail(`ChatGPT transport failed without proof of delivery; NOT resending: ${error.message}`, 3);
    }
    if (!result || result.chat_id !== bindings.conversation_id) {
      fail(`ChatGPT identity unproven (chat_id=${result?.chat_id}); treating as ambiguous, NOT resending.`, 3);
    }
    if (typeof result.response !== "string" || result.response.length === 0) fail("ChatGPT returned an empty response; NOT resending.", 3);
    writeNew(F("response"), result.response);
    writeNew(F("anchor"), `${JSON.stringify({
      chat_id: result.chat_id, conversation_id: bindings.conversation_id,
      model: result.model ?? null, elapsed_seconds: result.elapsed_seconds ?? null,
      poll_count: result.poll_count ?? null,
    }, null, 2)}\n`);
  } else {
    summary.resent_chatgpt = false;
  }

  // Step 4: single Codex return (exclusive; ambiguity marker blocks rerun).
  if (!fs.existsSync(F("ret"))) {
    if (fs.existsSync(F("attempt"))) fail("A continuation attempt is already ambiguous; reinjection forbidden.", 3);
    const response = fs.readFileSync(F("response"), "utf8");
    const anchor = readJson(F("anchor"));
    const envelope = validateCanaryContinue(response, {
      mission_id: bindings.mission_id, task_id: bindings.task_id,
      relay_request_id: bindings.relay_request_id, report_sha256,
    });
    if (envelope.decision !== "CONTINUE") fail(`Decision is ${envelope.decision}, not CONTINUE; nothing to inject.`);
    const { continuationBinding } = createCanaryBindings({
      mission_id: bindings.mission_id, task_id: bindings.task_id, thread_id: bindings.thread_id,
      working_directory: bindings.working_directory,
      ...(bindings.repo_root === null ? {} : { repo_root: bindings.repo_root }),
      chat_url: bindings.chat_url,
    });
    const prompt = buildCodexReturnText({
      envelope, relay_request_id: bindings.relay_request_id,
      conversation_id: bindings.conversation_id, response_anchor: anchor.chat_id,
    });
    const request = createCanaryCodexReturn({ continuationBinding, prompt, response_id: bindings.relay_request_id });
    const executable = String(options.codex_exe ?? options.codexExe ?? "C:\\Users\\shiro\\AppData\\Roaming\\npm\\codex.ps1");
    const impls = options.codex_impl ?? options.codexImpl ?? ["C:\\Users\\shiro\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js"];
    const runtime = createCanaryRuntimeBinding({
      executable_path: executable, version: "codex-cli",
      capabilities: { queue: false, resume: true },
      fingerprint_files: [executable, ...(Array.isArray(impls) ? impls : [impls]).map(String)],
    });
    const sender = createCanaryCodexSender({ continuationBinding, runtimeBinding: runtime, invoke });
    let captured = "";
    const capturing = async (invocation) => {
      const result = await invoke(invocation);
      captured = result?.stdout ?? "";
      return result;
    };
    const guarded = createCanaryCodexSender({ continuationBinding, runtimeBinding: runtime, invoke: capturing });
    let dispatched;
    try {
      dispatched = await guarded.send(request);
    } catch (error) {
      writeNew(F("attempt"), `${JSON.stringify({ status: "DELIVERY_UNKNOWN", at: new Date().toISOString(), message: String(error?.message || error) }, null, 2)}\n`);
      fail(`Codex continuation uncertain; reinjection forbidden: ${error.message}`, 3);
    }
    if (dispatched.thread_id !== bindings.thread_id) fail("Continuation proved a different thread; rejecting.", 4);
    const expect = options.expect;
    const record = {
      mode: dispatched.mode, return_id: request.return_id,
      thread_before: bindings.thread_id, thread_after: dispatched.thread_id,
      same_thread: true,
      expected_substring: expect === undefined ? null : String(expect),
      stdout_chars: captured.length,
    };
    writeNew(F("ret"), `${JSON.stringify(record, null, 2)}\n`);
    fs.writeFileSync(path.join(stateDir, "resume-stdout.jsonl"), captured, "utf8");
  } else {
    summary.reinjected_codex = false;
  }

  const ret = readJson(F("ret"));
  const evidence = {
    relay_request_id: bindings.relay_request_id, target_alias: bindings.target_alias,
    thread_before: bindings.thread_id, thread_after: ret.thread_after,
    same_thread: ret.same_thread, return_id: ret.return_id,
    completed_at: new Date().toISOString(),
  };
  writeEvidenceReceipt(F("evidence"), evidence);
  return { ...summary, ...evidence };
}

export function runStatus(options = {}) {
  const stateDir = String(options.state_dir ?? options.stateDir ?? fail("Missing --state-dir."));
  const exists = (name) => fs.existsSync(path.join(stateDir, ART[name]));
  const summary = {
    state_dir: stateDir,
    initialized: exists("bindings"),
    report_captured: exists("report"),
    chatgpt_sent: exists("slot"),
    chatgpt_response: exists("response"),
    codex_returned: exists("ret"),
    ambiguous_attempt: exists("attempt"),
  };
  if (summary.initialized) Object.assign(summary, readJson(path.join(stateDir, ART.bindings)));
  if (summary.codex_returned) Object.assign(summary, readJson(path.join(stateDir, ART.ret)));
  return summary;
}

function usage() {
  process.stderr.write([
    "Usage:",
    "  node tools/devexec-relay.mjs once --thread <uuid> --target <alias> (--report <text> | --report-file <path>) [--mission M] [--task T] [--nonce N] [--request-id R] [--cwd DIR] [--repo DIR] [--codex-exe PATH] [--codex-impl PATH]... [--expect TEXT] [--instruct TEXT] [--timeout-ms N] [--state-dir DIR]",
    "  node tools/devexec-relay.mjs status --state-dir <dir>",
    "",
  ].join("\n"));
}

async function main(argv) {
  const raw = parseArgs(argv);
  const args = { _: raw._ };
  for (const [key, value] of Object.entries(raw)) {
    if (key === "_") continue;
    args[key.replace(/-/g, "_")] = value;
  }
  const [command] = args._;
  if (command === "once") {
    const multi = [];
    const single = { ...args };
    delete single._;
    for (const key of ["codex-impl"]) {
      if (single[key] !== undefined && !Array.isArray(single[key])) single[key] = [single[key]];
    }
    void multi;
    console.log(JSON.stringify(await runOnce(single), null, 2));
    return;
  }
  if (command === "status") {
    console.log(JSON.stringify(runStatus(args), null, 2));
    return;
  }
  usage();
  process.exitCode = 2;
}

const invokedAsMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (invokedAsMain) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 1;
  });
}
