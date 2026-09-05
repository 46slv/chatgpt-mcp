#!/usr/bin/env node
// Read-only native Dev Exec console (P3).
// Canonical authority is always the files on disk (target registry,
// dev-exec-state, dev-exec-runs). This server keeps no model of its own:
// every response is re-read from canonical files, so a restart rebuilds
// the identical read model. Mutations arrive in P4/P6; P3 serves GET only.

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defaultRegistryPath, loadRegistryLenient } from "./target-registry.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY_BYTES = 65536;
const MAX_TAIL_LINES = 200;
const MAX_STEP_BYTES = 65536;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);
const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const STEP_FILE_RE = /^step-(\d{3})\.(ps1|stdout\.txt|stderr\.txt|result\.json|receipt\.json)$/;
const STEP_KINDS = new Map([
  ["ps1", "step-%N.ps1"],
  ["stdout", "step-%N.stdout.txt"],
  ["stderr", "step-%N.stderr.txt"],
  ["result", "step-%N.result.json"],
  ["receipt", "step-%N.receipt.json"],
]);
const TERMINAL_PHASES = new Set(["COMPLETE", "FAILED", "NEEDS_HUMAN", "CANCELLED"]);

// ---- canonical roots (source-owned resolution, env-overridable) ----
export function baseDir(env = process.env) {
  return env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
}

export function stateDir(env = process.env) {
  return env.DEV_EXEC_STATE_DIR || path.join(baseDir(env), "ChatGPTMCPProbe", "dev-exec-state");
}

export function runsDir(env = process.env) {
  return env.DEV_EXEC_RUNS_DIR || path.join(baseDir(env), "ChatGPTMCPProbe", "dev-exec-runs");
}

export function registryFile(env = process.env) {
  return defaultRegistryPath(env);
}

// ---- small guards ----
export function isValidRunId(value) {
  return typeof value === "string"
    && RUN_ID_RE.test(value)
    && !value.includes("..")
    && !path.isAbsolute(value);
}

function boundReason(error, max = 200) {
  const reason = String((error && error.message) || error || "unreadable");
  return reason.length > max ? reason.slice(0, max) : reason;
}

function normalizeHostname(hostname) {
  const value = String(hostname || "").trim().toLowerCase();
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

export function isLoopbackHostHeader(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(`http://${value.trim()}`);
    return LOOPBACK_HOSTNAMES.has(normalizeHostname(url.hostname));
  } catch {
    return false;
  }
}

export function isAllowedMutatingOrigin(value) {
  if (value === undefined) return true;
  if (typeof value !== "string" || !value.trim() || value === "null") return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && LOOPBACK_HOSTNAMES.has(normalizeHostname(url.hostname));
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      text += chunk;
      if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) reject(new Error("Request body too large."));
    });
    req.on("end", () => {
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });
    req.on("error", reject);
  });
}

// ---- read model: targets ----
export function listTargets(env = process.env) {
  const file = registryFile(env);
  const lenient = loadRegistryLenient(file);
  const rows = Object.entries(lenient.registry.targets).map(([alias, target]) => ({
    alias,
    valid: true,
    code: null,
    transport: target.transport || "chatgpt-web",
    title: target.title || null,
    chat_url: target.chat_url,
    conversation_id: target.conversation_id || null,
    error: null,
  }));
  const seen = new Set(rows.map((row) => row.alias));
  for (const entry of lenient.errors) {
    if (entry.code === "TARGET_DEFAULT_INVALID") continue;
    if (seen.has(entry.alias)) continue;
    seen.add(entry.alias);
    rows.push({
      alias: entry.alias,
      valid: false,
      code: entry.code,
      transport: null,
      title: null,
      chat_url: null,
      conversation_id: null,
      error: entry.error,
    });
  }
  rows.sort((a, b) => String(a.alias).localeCompare(String(b.alias)));
  return {
    registry_path: file,
    default_target: lenient.registry.default_target,
    default_invalid: lenient.invalidDefault,
    targets: rows,
  };
}

// ---- read model: runs ----
function mtimeIso(file) {
  try {
    return fs.statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
}

export function summarizeState(runId, state, stateFile) {
  const pending = state.pending || null;
  const last = state.last_result || null;
  return {
    run_id: runId,
    parent_run_id: state.parent_run_id || null,
    phase: state.phase || "UNKNOWN",
    step: Number.isInteger(state.step) ? state.step : 0,
    pending: pending !== null,
    pending_step: pending?.step ?? null,
    target_id: state.target?.target_id || null,
    chat_url: state.target?.chat_url || null,
    working_directory: pending?.working_directory || last?.workingDirectory || null,
    terminal: TERMINAL_PHASES.has(state.phase),
    terminal_reason: state.stop_reason || null,
    updated_at: mtimeIso(stateFile),
    last_result: last ? {
      step: last.step ?? null,
      exit_code: last.exitCode ?? null,
      timed_out: last.timedOut ?? null,
      duration_ms: last.durationMs ?? null,
    } : null,
  };
}

export function listRuns(env = process.env) {
  const dir = stateDir(env);
  if (!fs.existsSync(dir)) return { state_dir: dir, runs: [] };
  const rows = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const runId = entry.name.slice(0, -".json".length);
    const file = path.join(dir, entry.name);
    try {
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("state is not an object");
      rows.push(summarizeState(runId, state, file));
    } catch (error) {
      rows.push({
        run_id: runId, parent_run_id: null, phase: "UNREADABLE", step: 0,
        pending: false, pending_step: null, target_id: null, chat_url: null,
        working_directory: null, terminal: false, terminal_reason: null,
        updated_at: mtimeIso(file), last_result: null, error: boundReason(error),
      });
    }
  }
  rows.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
  return { state_dir: dir, runs: rows };
}

function tailJsonLines(file, maxLines) {
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line.length > 0);
  const tail = lines.slice(-Math.max(1, maxLines));
  return tail.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { unparsed: line.slice(0, 500) };
    }
  });
}

function stepIndex(runDir) {
  if (!fs.existsSync(runDir)) return [];
  const index = [];
  for (const entry of fs.readdirSync(runDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = STEP_FILE_RE.exec(entry.name);
    if (!match) continue;
    let size = null;
    try {
      size = fs.statSync(path.join(runDir, entry.name)).size;
    } catch {
      size = null;
    }
    index.push({ step: Number.parseInt(match[1], 10), file: entry.name, size });
  }
  index.sort((a, b) => a.step - b.step || String(a.file).localeCompare(String(b.file)));
  return index;
}

export function runDetail(runId, env = process.env) {
  if (!isValidRunId(runId)) {
    const error = new Error(`Invalid run id: ${String(runId).slice(0, 80)}`);
    error.status = 400;
    throw error;
  }
  const dir = stateDir(env);
  const file = path.join(dir, `${runId}.json`);
  if (!fs.existsSync(file)) {
    const error = new Error(`Run not found: ${runId}`);
    error.status = 404;
    throw error;
  }
  let state;
  try {
    state = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("state is not an object");
  } catch (error) {
    return { summary: null, unreadable: boundReason(error), state: null, events: [], steps: [], self_recovery: null, stop_alert: null };
  }
  const runDir = path.join(runsDir(env), runId);
  let stopAlert = null;
  try {
    const stopFile = path.join(runDir, "stop-alert.json");
    if (fs.existsSync(stopFile)) stopAlert = JSON.parse(fs.readFileSync(stopFile, "utf8"));
  } catch {
    stopAlert = { unreadable: true };
  }
  return {
    summary: summarizeState(runId, state, file),
    state,
    events: tailJsonLines(path.join(runDir, "events.jsonl"), MAX_TAIL_LINES) || [],
    steps: stepIndex(runDir),
    self_recovery: tailJsonLines(path.join(runDir, "self-recovery.jsonl"), 50),
    stop_alert: stopAlert,
  };
}

export function readStepFile(runId, step, kind, env = process.env) {
  if (!isValidRunId(runId)) {
    const error = new Error("Invalid run id.");
    error.status = 400;
    throw error;
  }
  if (!/^\d{1,5}$/.test(String(step || ""))) {
    const error = new Error("Invalid step number.");
    error.status = 400;
    throw error;
  }
  const pattern = STEP_KINDS.get(kind);
  if (!pattern) {
    const error = new Error(`Unknown step file kind: ${String(kind).slice(0, 40)}`);
    error.status = 400;
    throw error;
  }
  const name = pattern.replace("%N", String(step).padStart(3, "0"));
  const file = path.join(runsDir(env), runId, name);
  if (!fs.existsSync(file)) {
    const error = new Error(`Step file not found: ${name}`);
    error.status = 404;
    throw error;
  }
  const buffer = fs.readFileSync(file);
  const truncated = buffer.length > MAX_STEP_BYTES;
  return {
    run_id: runId,
    file: name,
    size: buffer.length,
    truncated,
    content: buffer.slice(0, MAX_STEP_BYTES).toString("utf8"),
  };
}

// ---- launcher (P4): console-owned native runs ----
const DEVEXEC_CLI = path.join(here, "devexec.mjs");
const MAX_PURPOSE_CHARS = 4000;
const MAX_RUN_LOG_LINES = 500;

export function generateRunId(prefix = "CONSOLE") {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

export function createControlStore() {
  return new Map();
}

function appendRunLog(record, source, chunk) {
  const at = new Date().toISOString();
  for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) record.log.push({ at, source, line });
  if (record.log.length > MAX_RUN_LOG_LINES) record.log.splice(0, record.log.length - MAX_RUN_LOG_LINES);
}

export function controlInfo(record) {
  if (!record) return null;
  return {
    run_id: record.run_id,
    kind: record.kind || "run",
    parent_run_id: record.parent_run_id || null,
    target_alias: record.target_alias,
    pid: record.pid,
    command: record.command,
    started_at: record.started_at,
    ended_at: record.ended_at,
    status: record.status,
    owned_by_console: true,
    exit_code: record.exit_code,
    signal: record.signal,
    log: record.log.slice(-50),
  };
}

export function listControls(controls) {
  return [...controls.values()].map(controlInfo);
}

/**
 * Launch a native devexec run as a console-owned child. The canonical run
 * state stays file-owned; the control record lives apart and only tracks
 * process ownership for safe stop/duplicate decisions.
 */
export function startRun({ targetAlias, purpose, controls, spawnFn = spawn, env = process.env } = {}) {
  if (!controls) {
    const error = new Error("Control store is required.");
    error.status = 500;
    throw error;
  }
  if (typeof targetAlias !== "string" || !targetAlias) {
    const error = new Error("target_alias is required.");
    error.status = 400;
    throw error;
  }
  const model = listTargets(env);
  const row = model.targets.find((t) => t.alias === targetAlias);
  if (!row || !row.valid) {
    const error = new Error(`Target alias is not usable: ${targetAlias}`);
    error.status = 400;
    error.code = "TARGET_ENTRY_INVALID";
    throw error;
  }
  const goal = String(purpose ?? "");
  if (!goal.trim()) {
    const error = new Error("purpose is required.");
    error.status = 400;
    throw error;
  }
  if (goal.length > MAX_PURPOSE_CHARS) {
    const error = new Error("purpose is too long.");
    error.status = 400;
    throw error;
  }
  assertNoLiveTarget(targetAlias, controls);
  const runId = generateRunId();
  const args = [DEVEXEC_CLI, "run", "--target", targetAlias];
  const record = spawnOwned({
    argv: args, targetAlias, runId, kind: "run", parentRunId: null,
    childEnv: { DEV_EXEC_PURPOSE: goal },
    controls, spawnFn, env,
  });
  return controlInfo(record);
}

function assertNoLiveTarget(targetAlias, controls) {
  for (const record of controls.values()) {
    if (record.target_alias === targetAlias && record.status === "RUNNING") {
      const error = new Error(`Target is already running under this console: ${targetAlias} (${record.run_id}).`);
      error.status = 409;
      error.code = "RUN_CONFLICT";
      throw error;
    }
  }
}

function requireControls(controls) {
  if (!controls) {
    const error = new Error("Control store is required.");
    error.status = 500;
    throw error;
  }
}

function spawnOwned({ argv, targetAlias, runId, childEnv = {}, kind, parentRunId = null, controls, spawnFn = spawn, env = process.env } = {}) {
  requireControls(controls);
  const child = spawnFn(process.execPath, argv, {
    cwd: process.cwd(),
    env: { ...env, DEV_EXEC_TARGET_ALIAS: targetAlias, DEV_EXEC_RUN_ID: runId, ...childEnv },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const record = {
    child, run_id: runId, target_alias: targetAlias, kind, parent_run_id: parentRunId,
    pid: (child && Number.isInteger(child.pid)) ? child.pid : null,
    command: [process.execPath, ...argv],
    started_at: new Date().toISOString(), ended_at: null,
    status: "RUNNING", exit_code: null, signal: null, log: [],
  };
  controls.set(runId, record);
  if (child.stdout && typeof child.stdout.on === "function") child.stdout.on("data", (chunk) => appendRunLog(record, "stdout", chunk));
  if (child.stderr && typeof child.stderr.on === "function") child.stderr.on("data", (chunk) => appendRunLog(record, "stderr", chunk));
  if (typeof child.on === "function") {
    child.on("error", (error) => appendRunLog(record, "error", (error && error.stack) || error));
    child.on("exit", (code, signal) => {
      record.status = "EXITED";
      record.ended_at = new Date().toISOString();
      record.exit_code = Number.isInteger(code) ? code : null;
      record.signal = signal || null;
    });
  }
  return record;
}

/**
 * Continue a terminal run as a console-owned child. The parent is never
 * rewritten: the CLI mints a child run that references it. Ambiguous
 * pending parents are refused (BLOCKED, never auto-resent) and the target
 * comes only from the explicit request or the parent frozen target.
 */
export function continueRun({ parentRunId, targetAlias = null, controls, spawnFn = spawn, env = process.env } = {}) {
  requireControls(controls);
  const detail = runDetail(parentRunId, env);
  if (!detail.summary) {
    const error = new Error(`Parent run is unreadable: ${parentRunId}`);
    error.status = 400;
    throw error;
  }
  const parent = detail.summary;
  if (!parent.terminal) {
    const error = new Error(`Parent run is not terminal: ${parentRunId} (phase=${parent.phase}).`);
    error.status = 400;
    error.code = "RUN_NOT_TERMINAL";
    throw error;
  }
  if (parent.pending) {
    const error = new Error(`Parent run has ambiguous pending execution: ${parentRunId} (step ${parent.pending_step}). Inspect and reconcile before continuing.`);
    error.status = 400;
    error.code = "RUN_PENDING_BLOCKED";
    throw error;
  }
  const alias = targetAlias || parent.target_id;
  if (typeof alias !== "string" || !alias) {
    const error = new Error("No usable target: pass an explicit target alias.");
    error.status = 400;
    throw error;
  }
  const model = listTargets(env);
  const row = model.targets.find((t) => t.alias === alias);
  if (!row || !row.valid) {
    const error = new Error(`Target alias is not usable: ${alias}`);
    error.status = 400;
    error.code = "TARGET_ENTRY_INVALID";
    throw error;
  }
  assertNoLiveTarget(alias, controls);
  const childRunId = generateRunId("CONSOLE-CONTINUE");
  const record = spawnOwned({
    argv: [DEVEXEC_CLI, "continue", parentRunId, "--target", alias],
    targetAlias: alias, runId: childRunId, kind: "continue", parentRunId: parent.run_id,
    childEnv: { DEV_EXEC_CONTINUE_RUN_ID: childRunId },
    controls, spawnFn, env,
  });
  return controlInfo(record);
}

/**
 * Read-only recovery evidence via the source-owned CLI (captured, bounded).
 * inspect/verify-journal only. reconcile mutates canonical state and has no
 * route: it stays a deliberate human CLI act until proven safe to automate.
 */
const RECOVERY_KINDS = new Set(["inspect", "verify-journal"]);

export function runRecovery(runId, kind, { env = process.env, timeoutMs = 30000 } = {}) {
  if (!isValidRunId(runId)) {
    const error = new Error("Invalid run id.");
    error.status = 400;
    throw error;
  }
  if (kind === "reconcile") {
    const error = new Error("reconcile is not automated: inspect first, then run it deliberately from a shell.");
    error.status = 400;
    error.code = "RECONCILE_DISABLED";
    throw error;
  }
  if (!RECOVERY_KINDS.has(kind)) {
    const error = new Error(`Unknown recovery kind: ${String(kind).slice(0, 40)}`);
    error.status = 400;
    throw error;
  }
  const result = spawnSync(process.execPath, [DEVEXEC_CLI, "recover", kind, runId], {
    cwd: process.cwd(),
    env: { ...env },
    encoding: "utf8",
    timeout: timeoutMs,
  });
  let parsed = null;
  let parseError = null;
  try {
    parsed = JSON.parse(String(result.stdout || ""));
  } catch (error) {
    parseError = String((error && error.message) || error);
  }
  return {
    kind, run_id: runId, exit_code: result.status,
    result: parsed, parse_error: parseError,
    stderr: String(result.stderr || "").slice(0, 2000),
  };
}

export function stopRun(runId, { controls } = {}) {
  const record = controls ? controls.get(runId) : null;
  if (!record || record.status !== "RUNNING") {
    const error = new Error("Only a run started by this console can be stopped safely.");
    error.status = 400;
    throw error;
  }
  if (!record.child || typeof record.child.kill !== "function" || !record.child.kill("SIGTERM")) {
    const error = new Error("Failed to request process termination.");
    error.status = 500;
    throw error;
  }
  record.status = "STOP_REQUESTED";
  appendRunLog(record, "console", "Operator requested stop.");
  return controlInfo(record);
}

// ---- HTTP server ----
function sendJson(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Native Dev Exec Console</title><style>
:root{font-family:Consolas,ui-monospace,monospace;color:#111;background:#f3f3ef}*{box-sizing:border-box}body{margin:0}header{height:58px;padding:0 20px;background:white;border-bottom:1px solid #bbb;display:flex;align-items:center;justify-content:space-between}h1{font-size:17px;margin:0}.layout{display:grid;grid-template-columns:400px 1fr 300px;height:calc(100vh - 58px)}aside{background:white;border-right:1px solid #bbb;overflow:auto}.item{padding:11px 14px;border-bottom:1px solid #ddd;cursor:pointer}.item.active,.item:hover{background:#ebebe5}.phase{font-weight:700}.muted{color:#666}.bad{color:#a31313}.good{color:#08783b}.main{padding:20px;overflow:auto}.side{padding:20px;overflow:auto;background:white;border-left:1px solid #bbb}.kv{display:grid;grid-template-columns:150px 1fr;gap:6px 12px;margin:14px 0;font-size:13px}pre{background:#111;color:#eee;padding:12px;white-space:pre-wrap;word-break:break-word;max-height:40vh;overflow:auto;font-size:12px}h2{font-size:15px;margin:0 0 4px}h3{font-size:13px;margin:18px 0 6px}@media(max-width:900px){.layout{grid-template-columns:1fr;display:block}aside{max-height:30vh}.side{border-left:0;border-top:1px solid #bbb}}
</style></head><body><header><h1>Native Dev Exec Console</h1><span id="time" class="muted"></span></header><div class="layout"><aside><h3>Targets</h3><div id="targets"></div><h3>Runs</h3><div id="runs"></div></aside><main id="main" class="main">loading...</main><div class="side"><h3>Launch</h3><div id="launch"><div class="muted">loading targets...</div></div><div id="launchmsg" class="muted"></div><h3>Console runs</h3><div id="controls"><div class="muted">none owned</div></div><h3>Recovery</h3><div class="muted">continue / inspect arrive in P6.</div></div></div><script>
let targets=[],runs=[],selected=null,owned=[];
async function loadControls(){try{owned=(await req('/api/controls')).controls||[]}catch(e){owned=[]}var n=document.getElementById('controls');var h='';for(var i=0;i<owned.length;i++){var o=owned[i];h+='<div class="item"><div><b>'+esc(o.run_id)+'</b></div><div class="muted">'+esc(o.target_alias)+' - '+esc(o.status)+'</div>';if(o.status==='RUNNING'){h+='<button data-stop="'+esc(o.run_id)+'">stop</button>'}h+='</div>'}n.innerHTML=h||'<div class="muted">none owned</div>';var btns=n.querySelectorAll('[data-stop]');for(var j=0;j<btns.length;j++){btns[j].onclick=stopOwned}}
async function stopOwned(e){var b=e.target||e.srcElement;var id=b.getAttribute('data-stop');try{await req('/api/runs/'+encodeURIComponent(id)+'/stop',{method:'POST'})}catch(err){alert(err.message)}await loadControls()}
async function loadLaunch(){var n=document.getElementById('launch');try{var t=await req('/api/targets');var opts='';var arr=t.targets||[];for(var i=0;i<arr.length;i++){if(arr[i].valid){opts+='<option value="'+esc(arr[i].alias)+'">'+esc(arr[i].alias)+'</option>'}}if(!opts){n.innerHTML='<div class="muted">no valid target</div>';return}n.innerHTML='<select id="target">'+opts+'</select><br><br><textarea id="purpose" rows="4" cols="30"></textarea><br><br><button id="start">start</button>';document.getElementById('start').onclick=startRun}catch(e){n.innerHTML='<div class="muted">no valid target</div>'}}
async function startRun(){var msg=document.getElementById('launchmsg');try{var r=await req('/api/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({target_alias:document.getElementById('target').value,purpose:document.getElementById('purpose').value})});msg.textContent='started '+r.run_id;selected=r.run_id;await load()}catch(e){msg.textContent=e.message}}const esc=v=>String(v??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
async function req(url,opt){const r=await fetch(url,opt);const d=await r.json();if(!r.ok)throw new Error(d.error||("HTTP "+r.status));return d}
function renderTargets(el,data){el.innerHTML=data.targets.map(t=>'<div class="item"><div><b>'+esc(t.alias)+'</b> '+(t.valid?'<span class="good">valid</span>':'<span class="bad">TARGET_ERROR</span>')+'</div><div class="muted">'+esc(t.conversation_id||t.error||"")+'</div></div>').join("")||'<div class="item muted">targetなし</div>'}
function renderRuns(el){el.innerHTML=runs.map(r=>'<div class="item '+(r.run_id===selected?"active":"")+'" data-id="'+esc(r.run_id)+'"><div class="phase">'+esc(r.phase)+'</div><div>'+esc(r.run_id)+'</div><div class="muted">step '+esc(r.step)+(r.pending?" · pending":"")+(r.terminal?" · terminal":"")+'</div></div>').join("")||'<div class="item muted">runなし</div>';el.querySelectorAll("[data-id]").forEach(x=>x.onclick=()=>{selected=x.dataset.id;renderRuns(el);detail()})}
async function detail(){const n=document.getElementById("main");try{const d=await req("/api/runs/"+encodeURIComponent(selected));const s=d.summary||{};const ev=(d.events||[]).map(e=>JSON.stringify(e)).join("\n");const steps=(d.steps||[]).map(x=>x.file+" ("+x.size+"B)").join("\n");n.innerHTML="<h2>"+esc(s.run_id||selected)+'</h2><div class="phase">'+esc(s.phase||"")+'</div><div class="kv"><span class="muted">parent</span><span>'+esc(s.parent_run_id||"—")+'</span><span class="muted">step</span><span>'+esc(s.step)+'</span><span class="muted">pending</span><span>'+esc(s.pending)+'</span><span class="muted">target</span><span>'+esc(s.target_id||"—")+'</span><span class="muted">workdir</span><span>'+esc(s.working_directory||"—")+'</span><span class="muted">terminal</span><span>'+esc(s.terminal)+'</span><span class="muted">updated</span><span>'+esc(s.updated_at||"—")+'</span></div><h3>recovery</h3><div id="recinfo" class="muted"></div><div class="buttons"><button id="cont">continue</button><button id="rins">inspect</button><button id="rver">verify</button></div><pre id="recout"></pre><h3>result</h3><pre>'+esc(JSON.stringify(s.last_result||null))+'</pre><h3>steps</h3><pre>'+esc(steps||"—")+'</pre><h3>events</h3><pre>'+esc(ev||"—")+"</pre>";wireDetail(s)}catch(e){n.innerHTML='<span class="bad">'+esc(e.message)+"</span>"}}
async function wireDetail(s){var info=document.getElementById('recinfo');if(!info)return;if(s.pending){info.innerHTML='<span class="bad">BLOCKED: ambiguous pending at step '+esc(s.pending_step)+'. Inspect before continuing; no auto-resend.</span>'}else if(s.parent_run_id){info.innerHTML='child of '+esc(s.parent_run_id)}var c=document.getElementById('cont');if(c){if(s.terminal&&!s.pending){c.onclick=doContinue}else{c.disabled=true}}document.getElementById('rins').onclick=function(){doRecover('inspect')};document.getElementById('rver').onclick=function(){doRecover('verify-journal')}}
async function doContinue(){var o=document.getElementById('recout');try{var r=await req('/api/runs/'+encodeURIComponent(selected)+'/continue',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});o.textContent='child '+r.run_id;selected=r.run_id;await load()}catch(e){o.textContent=e.message}}
async function doRecover(kind){var o=document.getElementById('recout');try{var r=await req('/api/runs/'+encodeURIComponent(selected)+'/recovery?kind='+kind);o.textContent=JSON.stringify(r,null,2).slice(0,12000)}catch(e){o.textContent=e.message}}
async function load(){try{const t=await req("/api/targets");targets=t.targets;renderTargets(document.getElementById("targets"),t);runs=(await req("/api/runs")).runs;if(selected&&!runs.some(r=>r.run_id===selected))selected=null;if(!selected&&runs[0])selected=runs[0].run_id;document.getElementById("time").textContent=new Date().toLocaleTimeString();renderRuns(document.getElementById("runs"));if(selected)detail();await loadLaunch();await loadControls()}catch(e){document.getElementById("main").innerHTML='<span class="bad">'+esc(e.message)+"</span>"}}
load();setInterval(load,2000);
</script></body></html>`;

export function createConsoleServer({ controls = createControlStore(), spawnFn = spawn, env = process.env } = {}) {
  return http.createServer(async (req, res) => {
    try {
      if (!LOOPBACK_PEERS.has(req.socket.remoteAddress || "")) return sendJson(res, 403, { error: "loopback only" });
      if (!isLoopbackHostHeader(req.headers.host)) return sendJson(res, 403, { error: "loopback Host required" });
      if (req.method === "POST" && !isAllowedMutatingOrigin(req.headers.origin)) return sendJson(res, 403, { error: "loopback Origin required for browser mutation" });
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const pathParts = url.pathname.split("/").filter(Boolean);
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "x-content-type-options": "nosniff" });
        return res.end(PAGE);
      }
      if (req.method === "GET" && url.pathname === "/api/targets") return sendJson(res, 200, listTargets(env));
      if (req.method === "GET" && url.pathname === "/api/runs") return sendJson(res, 200, listRuns(env));
      if (req.method === "GET" && url.pathname === "/api/controls") return sendJson(res, 200, { controls: listControls(controls) });
      if (req.method === "POST" && url.pathname === "/api/runs") {
        const body = await readBody(req);
        return sendJson(res, 200, startRun({ targetAlias: body.target_alias, purpose: body.purpose, controls, spawnFn, env }));
      }
      if (req.method === "POST" && pathParts.length === 4 && pathParts[0] === "api" && pathParts[1] === "runs" && pathParts[3] === "stop") {
        return sendJson(res, 200, stopRun(decodeURIComponent(pathParts[2]), { controls }));
      }
      if (req.method === "POST" && pathParts.length === 4 && pathParts[0] === "api" && pathParts[1] === "runs" && pathParts[3] === "continue") {
        const body = await readBody(req);
        return sendJson(res, 200, continueRun({ parentRunId: decodeURIComponent(pathParts[2]), targetAlias: (body && body.target_alias) || null, controls, spawnFn, env }));
      }
      if (req.method === "GET" && pathParts.length === 4 && pathParts[0] === "api" && pathParts[1] === "runs" && pathParts[3] === "recovery") {
        return sendJson(res, 200, runRecovery(decodeURIComponent(pathParts[2]), url.searchParams.get("kind") || "inspect", { env }));
      }
      if (req.method === "GET" && pathParts.length === 3 && pathParts[0] === "api" && pathParts[1] === "runs") {
        return sendJson(res, 200, runDetail(decodeURIComponent(pathParts[2]), env));
      }
      if (req.method === "GET" && pathParts.length === 6 && pathParts[0] === "api" && pathParts[1] === "runs" && pathParts[3] === "step") {
        return sendJson(res, 200, readStepFile(decodeURIComponent(pathParts[2]), pathParts[4], decodeURIComponent(pathParts[5]), env));
      }
      return sendJson(res, 404, { error: "not found" });
    } catch (error) {
      return sendJson(res, Number.isInteger(error.status) ? error.status : 400, { error: String(error.message || error) });
    }
  });
}

export function parseArgs(argv) {
  const options = { host: "127.0.0.1", port: 4319 };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const value = argv[i + 1];
    if (token === "--port") {
      if (!/^\d+$/.test(value || "")) throw new Error("--port requires an integer.");
      options.port = Number(value);
      if (options.port < 1 || options.port > 65535) throw new Error("--port is out of range.");
      i += 1;
    } else if (token === "--help" || token === "-h") {
      process.stdout.write("Usage: npm run console:native -- [--port 4319]\n");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const server = createConsoleServer(options);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(options.port, options.host, resolve); });
  const address = server.address();
  process.stdout.write(`[native console] http://${options.host}:${address.port}\n`);
  process.stdout.write(`[native console] state=${stateDir()} runs=${runsDir()} registry=${registryFile()}\n`);
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main().catch((error) => { process.stderr.write(`[native console] ERROR: ${error.message || error}\n`); process.exitCode = 1; });
