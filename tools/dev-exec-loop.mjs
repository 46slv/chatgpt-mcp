#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveTarget } from "./target-registry.mjs";
import { parseNaturalDirective } from "./dev-exec-natural-protocol.mjs";
import { loadMissionEscalation, appendMissionEscalationToReport } from "./devexec-mission-supervisor-envelope.mjs";
import { loadOpsSyncPacket, appendOpsSyncToReport } from "./devexec-ops-sync-envelope.mjs";
import { loadStopAlert, appendStopAlertToReport } from "./devexec-stop-alert-envelope.mjs";
import { inspectLocalAgentGoalCompletion } from "./devexec-local-agent-goal-state.mjs";

const RUN_ID =
  process.env.DEV_EXEC_RUN_ID ||
  `DEV-EXEC-${Date.now()}`;

process.env.DEV_EXEC_RUN_ID = RUN_ID;

const EXPLICIT_TARGET_ALIAS =
  process.env.DEV_EXEC_TARGET_ALIAS ||
  null;

const PARENT_RUN_ID =
 process.env.DEV_EXEC_PARENT_RUN_ID ||
 null;

const CONTINUE_FROM_PHASE =
 process.env.DEV_EXEC_CONTINUE_FROM_PHASE ||
 null;

const MAX_STEPS = Number.parseInt(
  process.env.DEV_EXEC_MAX_STEPS || "100",
  10
);

const MAX_SUPERVISOR_RETRIES = Number.parseInt(process.env.DEV_EXEC_MAX_SUPERVISOR_RETRIES || "3", 10);

const DEV_EXEC_PURPOSE =
  process.env.DEV_EXEC_PURPOSE ||
  "Automate a bounded ChatGPT-supervised development loop.";

const DEV_EXEC_TARGET =
  process.env.DEV_EXEC_TARGET ||
  "Continue the current development task from persisted state.";

const MAX_TIMEOUT_SEC = Number.parseInt(
  process.env.DEV_EXEC_MAX_TIMEOUT_SEC || "1800",
  10
);

const DOCS = process.env.DEV_EXEC_DOCS_ROOT || path.join(os.homedir(), "Documents");
const PROBE_ROOT = path.join(DOCS, "ChatGPTMCPProbe");
const EXPERIMENT_LOG = path.join(PROBE_ROOT, "EXPERIMENT_LOG.md");
const MCP_CONFIG = path.join(os.homedir(), ".lmstudio", "mcp.json");

const DEV_EXEC_MISSION_ESCALATION_FILE = process.env.DEV_EXEC_MISSION_ESCALATION_FILE || null;
const DEV_EXEC_OPS_SYNC_FILE = process.env.DEV_EXEC_OPS_SYNC_FILE || null;
function attachOpsSync(report) {
 let file = DEV_EXEC_OPS_SYNC_FILE || path.join(RUN_DIR, "ops-sync.json");
 if (!fs.existsSync(file) && PARENT_RUN_ID) {
 const parentFile = path.join(BASE, "ChatGPTMCPProbe", "dev-exec-runs", PARENT_RUN_ID, "ops-sync.json");
 if (fs.existsSync(parentFile)) file = parentFile;
 }
 if (!fs.existsSync(file)) return report;
 return appendOpsSyncToReport(report, loadOpsSyncPacket(file));
}
function attachStopAlert(report) {
 const file = path.join(RUN_DIR, 'stop-alert.json');
 if (!fs.existsSync(file)) return report;
 return appendStopAlertToReport(report, loadStopAlert(file));
}

function attachMissionEscalation(report) {
 const file = DEV_EXEC_MISSION_ESCALATION_FILE || path.join(RUN_DIR, "mission-escalation.json"); if (!fs.existsSync(file)) return report;
 let next = appendMissionEscalationToReport(report, loadMissionEscalation(file));
 const ownerFile = path.join(RUN_DIR, "local-agent-owner.json");
 if (fs.existsSync(ownerFile)) {
 const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
 if (owner.protocol !== "devexec.local-agent-owner" || owner.schema_version !== 1 || owner.dev_exec_run_id !== RUN_ID || !owner.agent_run_id || !owner.worker_run_id) throw new Error("Invalid local-agent-owner.json");
 const block = ["LOCAL AGENT OWNER", JSON.stringify({agent_run_id:owner.agent_run_id,worker_run_id:owner.worker_run_id,goal:owner.goal,resume_command:"node .\\tools\\devexec.mjs agent resume "+owner.agent_run_id}), "END LOCAL AGENT OWNER"].join("\n");
 const marker = "\nRequest:"; const pos = next.lastIndexOf(marker); next = pos >= 0 ? next.slice(0,pos)+"\n\n"+block+next.slice(pos) : next+"\n\n"+block;
 }
 return next;
}

const BASE =
  process.env.LOCALAPPDATA ||
  path.join(os.homedir(), "AppData", "Local");

const STATE_DIR = path.join(BASE, "ChatGPTMCPProbe", "dev-exec-state");
const RUN_DIR = path.join(BASE, "ChatGPTMCPProbe", "dev-exec-runs", RUN_ID);
const STATE_FILE = path.join(STATE_DIR, `${RUN_ID}.json`);
const EVENT_FILE = path.join(RUN_DIR, "events.jsonl");
const TRANSPORT_DIR = path.join(BASE, "ChatGPTMCPProbe", "transport-state");

function nowIso() {
  return new Date().toISOString();
}

function sha256(textOrBuffer) {
  return crypto.createHash("sha256").update(textOrBuffer).digest("hex");
}

function appendStateEvent(state) {
 fs.mkdirSync(RUN_DIR, { recursive: true });
 const event = {
 protocol: "dev-exec.event",
 schema_version: 1,
 run_id: RUN_ID,
 event_id: crypto.randomUUID(),
 at: nowIso(),
 phase: state.phase,
 step: state.step,
 parent_run_id: state.parent_run_id || null,
 pending_step: state.pending?.step || null,
 target_id: state.target?.target_id || null,
 state_sha256: sha256(JSON.stringify(state)),
 };
 fs.appendFileSync(EVENT_FILE, JSON.stringify(event) + String.fromCharCode(10), "utf8");
}

function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const temp = `${STATE_FILE}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", "utf8");
  try {
    fs.renameSync(temp, STATE_FILE);
  } catch {
    fs.rmSync(STATE_FILE, { force: true });
    fs.renameSync(temp, STATE_FILE);
  }
 appendStateEvent(state);
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      protocol: "dev-exec.state",
      schema_version: 1,
      run_id: RUN_ID,
 parent_run_id: PARENT_RUN_ID,
 continue_from_phase: CONTINUE_FROM_PHASE,
      phase: "INIT",
      step: 0,
      pending: null,
      last_result: null,
      rounds: {},
      target: null,
      created_at: nowIso()
    };
  }

  const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  if (state.run_id !== RUN_ID) {
    throw new Error("State run_id mismatch.");
  }
  return state;
}

function freezeRunTarget(state) {
  if (state.target?.chat_url) {
    return state.target;
  }

  const resolved = resolveTarget({
    explicitTarget: EXPLICIT_TARGET_ALIAS,
    cwd: PROBE_ROOT
  });

  state.target = {
    target_id: resolved.target_id,
    transport: resolved.transport,
    chat_url: resolved.chat_url,
    conversation_id: resolved.conversation_id,
    source: resolved.source,
    project_config: resolved.project_config || null,
    frozen_at: nowIso()
  };
  saveState(state);
  return state.target;
}

function appendExperimentLog(text) {
  fs.mkdirSync(path.dirname(EXPERIMENT_LOG), { recursive: true });
  fs.appendFileSync(EXPERIMENT_LOG, `\n${text.trim()}\n`, "utf8");
}

function readMcpServers() {
  const config = JSON.parse(fs.readFileSync(MCP_CONFIG, "utf8"));
  if (!config.mcpServers || typeof config.mcpServers !== "object") {
    throw new Error("mcp.json has no mcpServers.");
  }
  return config.mcpServers;
}

async function connectServer(name, extraEnv = {}) {
  const servers = readMcpServers();
  const config = servers[name];
  if (!config?.command) {
    throw new Error(`MCP server unavailable: ${name}`);
  }

  const client = new Client({
    name: `dev-exec-${name}`,
    version: "0.1.0"
  });

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args || [],
    env: {
      ...process.env,
      ...(config.env || {}),
      ...extraEnv
    }
  });

  await client.connect(transport);
  return client;
}

function extractJsonResult(result, toolName) {
  if (result?.isError) {
    throw new Error(`${toolName}: MCP isError=true`);
  }

  const blocks = (result?.content || [])
    .filter(item => item.type === "text")
    .map(item => item.text);

  if (blocks.length !== 1) {
    throw new Error(`${toolName}: expected exactly one text block`);
  }

  try {
    return JSON.parse(blocks[0]);
  } catch (error) {
    throw new Error(`${toolName}: invalid JSON: ${error.message}`);
  }
}

function transportStateFile(round) {
  fs.mkdirSync(TRANSPORT_DIR, { recursive: true });
  return path.join(TRANSPORT_DIR, `${RUN_ID}-DEV-R${round}.json`);
}

function readTransportPhase(file) {
  if (!fs.existsSync(file)) return "STARTING";
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")).phase || "UNKNOWN";
  } catch {
    return "STATE_UNREADABLE";
  }
}

async function sendSupervisor(state, round, report) {
  const key = String(round);
  const reportHash = sha256(report);
  const existing = state.rounds[key];

  if (existing) {
    if (existing.report_hash !== reportHash) {
      throw new Error(`Round ${round}: report changed for same run.`);
    }
    if (existing.send_state === "COMPLETED") {
      console.log(`[supervisor:r${round}] CACHED`);
      return existing.response;
    }
    if (existing.send_state === "IN_FLIGHT") {
      throw new Error(`BLOCKED_IN_FLIGHT: supervisor round ${round}`);
    }
  }

  state.rounds[key] = {
    report_hash: reportHash,
    report,
    send_state: "IN_FLIGHT",
    response: null
  };
  state.phase = `SUPERVISOR_ROUND_${round}_IN_FLIGHT`;
  saveState(state);

  const tFile = transportStateFile(round);
  fs.rmSync(tFile, { force: true });

  let client = null;
  let heartbeat = null;
  try {
     if (!state.target?.chat_url) {
      throw new Error("Run target was not frozen before supervisor send.");
    }

    client = await connectServer("chatgpt-web-probe", {
      CHATGPT_MCP_CHAT_URL: state.target.chat_url,
      DEV_EXEC_TARGET_ID: state.target.target_id,
      DEV_EXEC_TARGET_SOURCE: state.target.source,
      CHATGPT_MCP_TRANSPORT_STATE_FILE: tFile,
      CHATGPT_MCP_TRANSPORT_RUN_ID: `${RUN_ID}-DEV-R${round}`
    });

    const listed = await client.listTools();
    if (!listed.tools.some(tool => tool.name === "chatgpt_reply")) {
      throw new Error("chatgpt_reply unavailable.");
    }

    const started = Date.now();
    heartbeat = setInterval(() => {
      const elapsed = Math.floor((Date.now() - started) / 1000);
      console.log(`[supervisor:r${round}] phase=${readTransportPhase(tFile)} elapsed=${elapsed}s`);
    }, 5000);

    const result = await client.callTool(
      {
        name: "chatgpt_reply",
        arguments: { prompt: report, timeout_minutes: 30 }
      },
      undefined,
      { timeout: 35 * 60 * 1000, maxTotalTimeout: 35 * 60 * 1000 }
    );

    const envelope = extractJsonResult(result, "chatgpt_reply");
    if (typeof envelope.error === "string" && envelope.error.trim()) {
      throw new Error(`chatgpt_reply failed: ${envelope.error.trim()}`);
    }
    if (typeof envelope.response !== "string" || !envelope.response.trim()) {
      throw new Error("Supervisor returned empty response.");
    }

    state.rounds[key].response = envelope.response;
    state.rounds[key].send_state = "COMPLETED";
    state.phase = `SUPERVISOR_ROUND_${round}_RECEIVED`;
    saveState(state);
    console.log(`[supervisor:r${round}] COMPLETED`);
    return envelope.response;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (client) {
      try { await client.close(); } catch {}
    }
  }
}

function parseStrictDirective(text) {
  let raw = String(text ?? "");

  if (/<<<END_DEV_EXEC>>>\s*<<<DEV_EXEC:v1>>>\s*Decision:/i.test(raw)) {
    throw new Error("Multiple outer DEV_EXEC envelopes detected.");
  }

  const outerStart = raw.indexOf("<<<DEV_EXEC:v1>>>");
  const outerEnd = raw.lastIndexOf("<<<END_DEV_EXEC>>>");

  if (outerStart >= 0 && outerEnd >= outerStart) {
    raw = raw.slice(
      outerStart,
      outerEnd + "<<<END_DEV_EXEC>>>".length
    );
  }

  raw = raw
    .replace(/^<<<DEV_EXEC:v1>>>\s*/, "<<<DEV_EXEC:v1>>>\n")
    .replace(/\s+Decision:\s*/, "\nDecision: ")
    .replace(/\s+WorkingDirectory:\s*/, "\nWorkingDirectory: ")
    .replace(/\s+TimeoutSeconds:\s*/, "\nTimeoutSeconds: ")
    .replace(/\s*<<<POWERSHELL>>>\s*/, "\n<<<POWERSHELL>>>\n")
    .replace(
      /\s*<<<END_POWERSHELL>>>\s*(?=<<<END_DEV_EXEC>>>\s*$)/,
      "\n<<<END_POWERSHELL>>>\n"
    )
    .replace(/\s+Reason:\s*/, "\nReason: ")
    .replace(/\s*<<<END_DEV_EXEC>>>\s*$/, "\n<<<END_DEV_EXEC>>>");

  const lines = raw.split(/\r?\n/);
  const START = "<<<DEV_EXEC:v1>>>";
  const END = "<<<END_DEV_EXEC>>>";
  const PS_START = "<<<POWERSHELL>>>";
  const PS_END = "<<<END_POWERSHELL>>>";

  const first = lines.findIndex(line => line.trim().length > 0);
  let last = lines.length - 1;
  while (last >= 0 && !lines[last].trim()) last -= 1;

  if (first < 0 || lines[first].trim() !== START || lines[last]?.trim() !== END) {
    throw new Error("DEV_EXEC v1 response must be exactly one outer protocol envelope.");
  }

  const bodyLines = lines.slice(first + 1, last);
  const decisionLine = bodyLines.find(line => /^Decision:\s*/.test(line.trim()));
  const decision = decisionLine?.trim().match(/^Decision:\s*(RUN|STOP|NEEDS_HUMAN)\b/)?.[1];
  if (!decision) throw new Error("DEV_EXEC Decision missing.");

  if (decision !== "RUN") {
    if (bodyLines.some(line => line.trim() === PS_START || line.trim() === PS_END)) {
      throw new Error(`${decision} must not contain POWERSHELL.`);
    }
    const reason = bodyLines.join("\n").match(/^Reason:\s*([^\r\n]+)$/m)?.[1]?.trim() || "";
    return { decision, reason };
  }

  const psStart = lines.findIndex((line, index) => index > first && index < last && line.trim() === PS_START);
  let psEnd = -1;
  for (let i = last - 1; i > psStart; i -= 1) {
    if (lines[i].trim() === PS_END) {
      psEnd = i;
      break;
    }
  }

  if (psStart < 0 || psEnd <= psStart) {
    throw new Error("RUN requires WorkingDirectory, TimeoutSeconds, and POWERSHELL block.");
  }

  const headerLines = lines.slice(first + 1, psStart);
  if (headerLines.some(line => {
    const marker = line.trim();
    return marker === START || marker === END || marker === PS_END;
  })) {
    throw new Error("Unexpected protocol marker before POWERSHELL block.");
  }

  const trailerLines = lines.slice(psEnd + 1, last);
  if (trailerLines.some(line => line.trim().length > 0)) {
    throw new Error("Unexpected content after POWERSHELL block.");
  }

  const header = headerLines.join("\n");
  const workingDirectory = header.match(/^WorkingDirectory:\s*(.+?)\s*$/m)?.[1]?.trim();
  const timeoutRaw = header.match(/^TimeoutSeconds:\s*(\d+)\s*$/m)?.[1];

  if (!workingDirectory || !timeoutRaw) {
    throw new Error("RUN requires WorkingDirectory and TimeoutSeconds.");
  }

  const timeoutSeconds = Number.parseInt(timeoutRaw, 10);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_TIMEOUT_SEC) {
    throw new Error(`TimeoutSeconds must be 1..${MAX_TIMEOUT_SEC}.`);
  }

  const script = lines.slice(psStart + 1, psEnd).join("\n");
  if (!script.trim()) throw new Error("POWERSHELL block is empty.");

  return { decision, workingDirectory, timeoutSeconds, script };
}

function parseDirective(text) {
 const raw = String(text ?? "");
 if (raw.includes("<<<DEV_EXEC:v1>>>")) {
 return parseStrictDirective(text);
 }
 return parseNaturalDirective(text, {
 defaultWorkingDirectory: path.join(DOCS, "ChatGPTMCPProbe"),
 defaultTimeoutSeconds: Math.min(240, MAX_TIMEOUT_SEC),
 maxTimeoutSeconds: MAX_TIMEOUT_SEC,
 });
}

function canonicalPath(value) {
  return path.resolve(value).replace(/[\\/]+$/, "").toLowerCase();
}

function isAllowedWorkingDirectory(value) {
  const candidate = path.resolve(value);
  const canonical = canonicalPath(candidate);
  const exactRoots = [
    path.join(DOCS, "ChatGPTMCPProbe"),
    path.join(DOCS, "HeadPatch"),
    path.join(DOCS, "LocalExecutorRepo")
  ].map(canonicalPath);

  if (exactRoots.includes(canonical)) return true;

  const parent = canonicalPath(path.dirname(candidate));
  const docsCanonical = canonicalPath(DOCS);
  const base = path.basename(candidate);
  if (parent === docsCanonical && /^LocalExecutor-he-[A-Za-z0-9._-]+$/i.test(base)) {
    return true;
  }
  return false;
}

function validateScript(script) {
  if (script.length > 150000) {
    throw new Error("PowerShell script exceeds 150000 characters.");
  }

  const forbidden = [
    /\bgit\s+push\b/i,
    /\bgit\s+reset\b/i,
    /\bgit\s+clean\b/i,
    /\bgit\s+rebase\b/i,
    /\bgit\s+worktree\s+(?:remove|prune)\b/i,
    /\bgit\s+branch\s+-D\b/i,
    /\bgit\s+checkout\s+--\b/i,
    /\bgit\s+restore\b/i,
    /\bRemove-Item\b/i,
    /\bdel(?:ete)?\s+/i,
    /\brm\s+/i,
    /\bFormat-Volume\b/i,
    /\bClear-Disk\b/i,
    /\bInitialize-Disk\b/i,
    /\bStop-Computer\b/i,
    /\bRestart-Computer\b/i,
    /\bshutdown(?:\.exe)?\b/i,
    /\bInvoke-Expression\b/i,
    /\biex\b/i,
    /\bStart-Process\b[^\r\n]*-Verb\s+RunAs\b/i
  ];

  for (const pattern of forbidden) {
    if (pattern.test(script)) {
      throw new Error(`PowerShell script rejected by safety filter: ${pattern}`);
    }
  }
}

function isAdministrator() {
  try {
    const result = spawnSyncCompat(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"
      ],
      10000
    );
    return result.stdout.trim().toLowerCase() === "true";
  } catch {
    return true;
  }
}

function spawnSyncCompat(command, args, timeoutMs) {
  const { spawnSync } = requireCompatChildProcess();
  const result = spawnSync(command, args, {
    windowsHide: true,
    shell: false,
    encoding: "utf8",
    timeout: timeoutMs
  });
  if (result.error) throw result.error;
  return {
    code: result.status ?? -1,
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };
}

function requireCompatChildProcess() {
  return {
    spawnSync: (...args) => {
      const cp = globalThis.__devExecCp;
      if (!cp) throw new Error("spawnSync compatibility helper not initialized");
      return cp.spawnSync(...args);
    }
  };
}

async function initializeCompat() {
  const cp = await import("node:child_process");
  globalThis.__devExecCp = cp;
}

function buildReadyReport() {
  return `DEV EXEC REPORT
Run: ${RUN_ID}
Step: 0
Machine: ${process.env.COMPUTERNAME || os.hostname()}
Status: READY

Purpose:
${DEV_EXEC_PURPOSE}

Execution boundary:
- This dedicated loop may execute only explicit supervisor intent from this conversation: strict DEV_EXEC:v1 directives, explicit RUN/EXECUTE Natural Protocol, or the bounded Japanese Natural Conversation intents accepted by the parser.
- PowerShell is non-elevated only.
- WorkingDirectory is restricted to ChatGPTMCPProbe, HeadPatch, LocalExecutorRepo, or LocalExecutor-he-* worktrees under Documents.
- Destructive Git/system commands are blocked by the runner.
- Every received script, SHA256, stdout, stderr, exit code, and error is persisted locally.
- Same run/step is not automatically re-executed after an ambiguous in-flight state.

Current target:
${DEV_EXEC_TARGET}

Request:
Reply with a clear execution intent. Bounded Japanese natural-language intents for run, continue, stop, and human intervention are accepted. RUN/STOP/NEEDS_HUMAN and strict DEV_EXEC:v1 remain accepted as fallback. Execution requires exactly one powershell/pwsh/ps1 fenced block; WorkingDirectory and Timeout are optional and safe defaults apply.
END DEV EXEC REPORT`;
}

function buildResultReport(result) {
  const clip = (text, max = 60000) => {
    if (text.length <= max) return text;
    return text.slice(0, max) + `\n...[TRUNCATED ${text.length - max} chars]`;
  };

  return `DEV EXEC REPORT
Run: ${RUN_ID}
Step: ${result.step}
Machine: ${process.env.COMPUTERNAME || os.hostname()}
Status: ${result.exitCode === 0 && !result.timedOut && !(result.stderr || "").trim() ? "PASS" : "FAIL"}
WorkingDirectory: ${result.workingDirectory}
TimeoutSeconds: ${result.timeoutSeconds}
TimedOut: ${result.timedOut}
ExitCode: ${result.exitCode}
ScriptSHA256: ${result.scriptSha256}
StdoutSHA256: ${result.stdoutSha256}
StderrSHA256: ${result.stderrSha256}
DurationMs: ${result.durationMs}

<<<STDOUT>>>
${clip(result.stdout)}
<<<END_STDOUT>>>

<<<STDERR>>>
${clip(result.stderr)}
<<<END_STDERR>>>

Request:
Review the result and reply with a clear execution intent. Bounded Japanese natural-language intents for run, continue, stop, and human intervention are accepted. RUN/STOP/NEEDS_HUMAN and strict DEV_EXEC:v1 remain accepted as fallback; execution requires exactly one powershell/pwsh/ps1 fenced block.
END DEV EXEC REPORT`;
}

function runPowerShell(step, workingDirectory, script, timeoutSeconds) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(RUN_DIR, { recursive: true });

    const scriptPath = path.join(RUN_DIR, `step-${String(step).padStart(3, "0")}.ps1`);
    const stdoutPath = path.join(RUN_DIR, `step-${String(step).padStart(3, "0")}.stdout.txt`);
    const stderrPath = path.join(RUN_DIR, `step-${String(step).padStart(3, "0")}.stderr.txt`);
    const resultPath = path.join(RUN_DIR, `step-${String(step).padStart(3, "0")}.result.json`); const receiptPath = path.join(RUN_DIR, `step-${String(step).padStart(3, "0")}.receipt.json`); const writeReceipt = data => fs.writeFileSync(receiptPath, JSON.stringify({ protocol: "dev-exec.exec-receipt", schema_version: 1, run_id: RUN_ID, step, ...data }, null, 2) + String.fromCharCode(10), "utf8");

    fs.writeFileSync(scriptPath, script.replace(/\r?\n/g, "\r\n") + "\r\n", "utf8");
    const scriptBytes = fs.readFileSync(scriptPath);
    const scriptSha256 = sha256(scriptBytes); writeReceipt({ phase: "PREPARED", scriptSha256, workingDirectory, timeoutSeconds, preparedAt: nowIso() });

    const startedAt = Date.now();
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath
      ],
      {
        cwd: workingDirectory,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    writeReceipt({ phase: "SPAWNED", scriptSha256, workingDirectory, timeoutSeconds, pid: child.pid ?? null, spawnedAt: nowIso() }); let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill();
    }, timeoutSeconds * 1000);

    child.on("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    const finalize = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const completedAt = Date.now();

      fs.writeFileSync(stdoutPath, stdout, "utf8");
      fs.writeFileSync(stderrPath, stderr, "utf8");
      const stdoutSha256 = sha256(Buffer.from(stdout, "utf8"));
      const stderrSha256 = sha256(Buffer.from(stderr, "utf8"));

      const result = {
        protocol: "dev-exec.result",
        schema_version: 1,
        run_id: RUN_ID,
        step,
        workingDirectory,
        timeoutSeconds,
        timedOut,
        exitCode: Number.isInteger(code) ? code : -1,
        scriptSha256,
        stdoutSha256,
        stderrSha256,
        durationMs: completedAt - startedAt,
        startedAt: new Date(startedAt).toISOString(),
        completedAt: new Date(completedAt).toISOString(),
        scriptPath,
        stdoutPath,
        stderrPath,
        resultPath,
        stdout,
        stderr
      };

      fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n", "utf8"); writeReceipt({ phase: "RESULT_WRITTEN", scriptSha256, pid: child.pid ?? null, exitCode: result.exitCode, timedOut: result.timedOut, resultPath, stdoutSha256, stderrSha256, completedAt: result.completedAt });
      resolve(result);
    };

    let observedExitCode = null;
    let exitGraceTimer = null;

    child.on("exit", code => {
      if (settled) return;
      observedExitCode = Number.isInteger(code) ? code : 1; writeReceipt({ phase: "EXITED", scriptSha256, pid: child.pid ?? null, exitCode: observedExitCode, timedOut, exitedAt: nowIso() });
      exitGraceTimer = setTimeout(() => {
        if (settled) return;
        console.warn(`[exec:${step}] child exited but close was not observed within 1500ms; forcing stream finalization`);
        if (child.stdout && !child.stdout.readableEnded) child.stdout.destroy();
        if (child.stderr && !child.stderr.readableEnded) child.stderr.destroy();
        finalize(observedExitCode);
      }, 1500);
      exitGraceTimer.unref?.();
    });

    child.on("close", code => {
      if (exitGraceTimer) clearTimeout(exitGraceTimer);
      finalize(Number.isInteger(code) ? code : (observedExitCode ?? 1));
    });
  });
}
function appendStepLog(result) {
  const summary = [
    `## DEV_EXEC ${RUN_ID} Step ${result.step}`,
    "",
    `WorkingDirectory: ${result.workingDirectory}`,
    `Script SHA256: ${result.scriptSha256}`,
    `TimeoutSeconds: ${result.timeoutSeconds}`,
    `TimedOut: ${result.timedOut}`,
    `ExitCode: ${result.exitCode}`,
    `Stdout SHA256: ${result.stdoutSha256}`,
    `Stderr SHA256: ${result.stderrSha256}`,
    `DurationMs: ${result.durationMs}`,
    `Result: ${result.exitCode === 0 && !result.timedOut && !(result.stderr || "").trim() ? "PASS" : "FAIL"}`,
    "",
    "### STDOUT",
    "```text",
    result.stdout.slice(0, 12000),
    "```",
    "",
    "### STDERR",
    "```text",
    result.stderr.slice(0, 12000),
    "```"
  ].join("\n");

  appendExperimentLog(summary);
}

async function main() {
  await initializeCompat();

  if (isAdministrator()) {
    throw new Error("Dev Exec Loop refuses to run from an elevated Administrator process.");
  }

  fs.mkdirSync(RUN_DIR, { recursive: true });
  const state = loadState();
  const runTarget = freezeRunTarget(state);
  console.log("=== DEV EXEC LOOP ===");
  console.log(`Run: ${RUN_ID}`);
  console.log(`State: ${STATE_FILE}`);
  console.log(`RunDir: ${RUN_DIR}`);
  console.log(`Target: ${runTarget.target_id} (${runTarget.source}) -> ${runTarget.chat_url}`);
  console.log("");

  if (state.phase === "COMPLETE") {
    console.log("Run already COMPLETE.");
    return;
  }

  if (state.pending) {
    throw new Error(
      `BLOCKED_EXEC_IN_FLIGHT: step ${state.pending.step} has ambiguous local execution state. ` +
      `Inspect ${RUN_DIR} before any new run.`
    );
  }

  let report = attachStopAlert(attachOpsSync(attachMissionEscalation(state.last_result ? buildResultReport(state.last_result) : buildReadyReport())));
 if (process.env.DEV_EXEC_REPORT_ONLY === "1") {
 process.stdout.write(report + String.fromCharCode(10));
 return;
 }
  let round = state.step + 1;

  while (state.step < MAX_STEPS) {
    const response = await sendSupervisor(state, round, report);
    let directive;
    try {
      directive = parseDirective(response);
    } catch (error) {
      const key = String(round);
      state.supervisor_retries ||= {};
      state.supervisor_invalid_responses ||= {};
      state.supervisor_invalid_responses[key] ||= [];
      const retryCount = (state.supervisor_retries[key] || 0) + 1;
      state.supervisor_retries[key] = retryCount;
      const invalidHash = sha256(response);
      state.supervisor_invalid_responses[key].push({
        at: nowIso(),
        sha256: invalidHash,
        preview: response.slice(0, 500),
        error: String(error)
      });
      if (state.rounds[key]) {
        state.rounds[key].send_state = "INVALID_RESPONSE";
        state.rounds[key].response = response;
      }
      state.phase = `SUPERVISOR_ROUND_${round}_INVALID_RESPONSE`;
      state.error = null;
      delete state.failed_at;
      saveState(state);
      appendExperimentLog(`## DEV_EXEC ${RUN_ID} supervisor invalid response\n\nRound: ${round}\nAttempt: ${retryCount}\nResponse SHA256: ${invalidHash}\nParse error: ${String(error)}`);
      if (retryCount >= MAX_SUPERVISOR_RETRIES) {
        state.phase = "NEEDS_HUMAN";
        state.stop_type = "SUPERVISOR_INVALID_PROTOCOL";
        state.stop_reason = `Supervisor returned invalid DEV_EXEC protocol ${retryCount} consecutive times at round ${round}.`;
        saveState(state);
        console.log(`NEEDS_HUMAN: ${state.stop_reason}`);
        process.exitCode = 2;
        return;
      }
      console.log(`[supervisor:r${round}] INVALID_RESPONSE retry=${retryCount}/${MAX_SUPERVISOR_RETRIES} sha256=${invalidHash}`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }
    if (state.supervisor_retries?.[String(round)]) {
      delete state.supervisor_retries[String(round)];
      saveState(state);
    }

    if (directive.decision === "STOP") {
      state.phase = "COMPLETE";
      state.completed_at = nowIso();
      state.stop_reason = directive.reason || "Supervisor STOP";
      saveState(state);
      appendExperimentLog(`## DEV_EXEC ${RUN_ID} COMPLETE\n\nReason: ${state.stop_reason}`);
      console.log(`STOP: ${state.stop_reason}`);
      return;
    }

    if (directive.decision === "NEEDS_HUMAN") {
      state.phase = "NEEDS_HUMAN";
      state.stop_reason = directive.reason || "Supervisor requested human intervention";
      saveState(state);
      appendExperimentLog(`## DEV_EXEC ${RUN_ID} NEEDS_HUMAN\n\nReason: ${state.stop_reason}`);
      console.log(`NEEDS_HUMAN: ${state.stop_reason}`);
      process.exitCode = 2;
      return;
    }

    try {
      if (!fs.existsSync(directive.workingDirectory) || !fs.statSync(directive.workingDirectory).isDirectory()) {
        throw new Error(`WorkingDirectory does not exist: ${directive.workingDirectory}`);
      }
      if (!isAllowedWorkingDirectory(directive.workingDirectory)) {
        throw new Error(`WorkingDirectory rejected by allowlist: ${directive.workingDirectory}`);
      }
      validateScript(directive.script);
    } catch (error) {
      const key = String(round);
      state.supervisor_directive_retries ||= {};
      state.supervisor_invalid_responses ||= {};
      state.supervisor_invalid_responses[key] ||= [];
      const retryCount = (state.supervisor_directive_retries[key] || 0) + 1;
      state.supervisor_directive_retries[key] = retryCount;
      const rejectedHash = sha256(response);
      state.supervisor_invalid_responses[key].push({
        at: nowIso(),
        sha256: rejectedHash,
        preview: response.slice(0, 1000),
        error: `PRE_EXEC_REJECTED: ${String(error)}`
      });
      if (state.rounds[key]) {
        state.rounds[key].send_state = "INVALID_RESPONSE";
        state.rounds[key].response = response;
      }
      state.phase = `SUPERVISOR_ROUND_${round}_DIRECTIVE_REJECTED`;
      state.error = null;
      delete state.failed_at;
      saveState(state);
      appendExperimentLog(`## DEV_EXEC ${RUN_ID} supervisor directive rejected\n\nRound: ${round}\nAttempt: ${retryCount}\nResponse SHA256: ${rejectedHash}\nReason: ${String(error)}\nExecution occurred: NO`);
      if (retryCount >= MAX_SUPERVISOR_RETRIES) {
        state.phase = "NEEDS_HUMAN";
        state.stop_type = "SUPERVISOR_PRE_EXEC_REJECTED";
        state.stop_reason = `Supervisor produced ${retryCount} consecutive pre-execution rejected directives at round ${round}.`;
        saveState(state);
        console.log(`NEEDS_HUMAN: ${state.stop_reason}`);
        process.exitCode = 2;
        return;
      }
      console.log(`[supervisor:r${round}] DIRECTIVE_REJECTED retry=${retryCount}/${MAX_SUPERVISOR_RETRIES} reason=${String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }
    if (state.supervisor_directive_retries?.[String(round)]) {
      delete state.supervisor_directive_retries[String(round)];
      saveState(state);
    }

    const nextStep = state.step + 1;
    const scriptHash = sha256(directive.script);
    state.phase = "EXEC_IN_FLIGHT";
    state.pending = {
      step: nextStep,
      working_directory: directive.workingDirectory,
      timeout_seconds: directive.timeoutSeconds,
      script_sha256: scriptHash,
      script: directive.script,
      accepted_at: nowIso()
    };
    saveState(state);

    const result = await runPowerShell(
      nextStep,
      directive.workingDirectory,
      directive.script,
      directive.timeoutSeconds
    );

    state.step = nextStep;
    state.last_result = result;
    state.pending = null;
    state.phase = result.exitCode === 0 && !result.timedOut && !(result.stderr || "").trim() ? "STEP_PASS" : "STEP_FAIL";
    saveState(state);
    appendStepLog(result);
 const localGoal = inspectLocalAgentGoalCompletion({ runDir: RUN_DIR, base: BASE, runId: RUN_ID });
 if (localGoal?.complete) {
 state.phase = "COMPLETE";
 state.stop_reason = "Local Agent goal completed without another supervisor round.";
 state.local_agent_completion = { agent_run_id: localGoal.owner.agent_run_id, worker_run_id: localGoal.owner.worker_run_id, status: localGoal.agent.status, decision: localGoal.agent.decision };
 saveState(state);
 appendExperimentLog(`## DEV_EXEC ${RUN_ID} LOCAL_AGENT_COMPLETE\n\nAgent: ${localGoal.owner.agent_run_id}\nWorker: ${localGoal.owner.worker_run_id}\nDecision: ${localGoal.agent.decision}`);
 console.log(`LOCAL_AGENT_COMPLETE: ${localGoal.owner.agent_run_id}`);
 return;
 }

    console.log(`[exec:${nextStep}] exit=${result.exitCode} timedOut=${result.timedOut}`);
    report = attachStopAlert(attachOpsSync(attachMissionEscalation(buildResultReport(result))));
    round = state.step + 1;
  }

  state.phase = "NEEDS_HUMAN";
  state.stop_type = "MAX_STEPS_REACHED";
 state.stop_reason = `Maximum step count reached: ${MAX_STEPS}`;
  saveState(state);
  appendExperimentLog(`## DEV_EXEC ${RUN_ID} NEEDS_HUMAN\n\nReason: ${state.stop_reason}`);
  console.log(state.stop_reason);
  process.exitCode = 2;
}

main().catch(error => {
  const message = error?.stack || String(error);
  try {
    const state = loadState();
    state.phase = "FAILED";
    state.error = message;
    state.failed_at = nowIso();
    saveState(state);
    appendExperimentLog(`## DEV_EXEC ${RUN_ID} ERROR\n\nStatus: FAIL\nRoot cause: OPEN\n\nError:\n${message}`);
  } catch {}
  console.error("");
  console.error("=== DEV EXEC LOOP RESULT ===");
  console.error("FAIL");
  console.error(message);
  process.exit(1);
});





