#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_CLOSED_LOOP_ADMISSION_ROOT,
  loadClosedLoopAdmission,
} from "./devexec-closed-loop-facade.mjs";
import { createClosedLoopStateStore } from "./devexec-closed-loop.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const closedLoopCli = path.join(here, "devexec-closed-loop-cli.mjs");
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4318;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_LOG_LINES = 500;
const processes = new Map();

function parseArgs(argv) {
  const result = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    admissionRoot: process.env.DEV_EXEC_CLOSED_LOOP_ADMISSION_DIR || DEFAULT_CLOSED_LOOP_ADMISSION_ROOT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const value = argv[i + 1];
    if (token === "--port") {
      if (!/^\d+$/.test(value || "")) throw new Error("--port requires an integer.");
      result.port = Number(value);
      if (result.port < 1 || result.port > 65535) throw new Error("--port is out of range.");
      i += 1;
      continue;
    }
    if (token === "--admission-root") {
      if (!value || !path.isAbsolute(value)) throw new Error("--admission-root requires an absolute path.");
      result.admissionRoot = path.resolve(value);
      i += 1;
      continue;
    }
    if (token === "--host") {
      if (value !== DEFAULT_HOST && value !== "::1") throw new Error("Dev Exec Console is loopback-only; --host must be 127.0.0.1 or ::1.");
      result.host = value;
      i += 1;
      continue;
    }
    if (token === "--help" || token === "-h") {
      process.stdout.write("Usage: node tools/devexec-console.mjs [--port 4318] [--admission-root <absolute path>]\n");
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return result;
}

function json(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function html(res, body) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });
    req.on("error", reject);
  });
}

function listAdmissionFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(root, entry.name));
}

function stateForAdmission(admission) {
  try {
    const store = createClosedLoopStateStore({ stateDir: admission.state_dir });
    return store.load(admission.loop_id);
  } catch (error) {
    return { status: "UNREADABLE", error: String(error.message || error) };
  }
}

function processSnapshot(admissionId) {
  const record = processes.get(admissionId);
  if (!record) return null;
  return {
    admission_id: admissionId,
    pid: record.child.pid || null,
    status: record.status,
    started_at: record.started_at,
    ended_at: record.ended_at,
    exit_code: record.exit_code,
    signal: record.signal,
    log: record.log.slice(-MAX_LOG_LINES),
  };
}

export function listAdmissions(admissionRoot) {
  const rows = [];
  for (const file of listAdmissionFiles(admissionRoot)) {
    try {
      const admission = loadClosedLoopAdmission(file, { admissionRoot });
      const state = stateForAdmission(admission);
      rows.push({
        admission_id: admission.admission_id,
        mission_id: admission.mission_id,
        task_id: admission.task_id,
        goal: admission.goal || null,
        current_task: admission.current_task || null,
        execution_mode: admission.execution_mode,
        thread_id: admission.codex_continuation_binding?.thread_id || admission.thread_probe?.thread_id || null,
        working_directory: admission.codex_runtime_binding?.working_directory || null,
        created_at: admission.created_at,
        updated_at: admission.updated_at,
        phase: state?.phase || state?.status || "NOT_STARTED",
        round_index: state?.round_index ?? 0,
        semantic_terminal: state?.semantic_terminal ?? false,
        supervisor_decision: state?.supervisor_decision ?? null,
        terminal_reason: state?.terminal_reason ?? null,
        error_code: state?.error_code ?? null,
        state,
        process: processSnapshot(admission.admission_id),
      });
    } catch (error) {
      rows.push({ file, phase: "UNREADABLE", error: String(error.message || error) });
    }
  }
  rows.sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")));
  return rows;
}

function appendLog(record, source, chunk) {
  const text = String(chunk);
  const lines = text.split(/\r?\n/).filter(Boolean);
  const now = new Date().toISOString();
  for (const line of lines) record.log.push({ at: now, source, line });
  if (record.log.length > MAX_LOG_LINES * 2) record.log.splice(0, record.log.length - MAX_LOG_LINES);
}

export function startAdmission(admissionId, { admissionRoot, relayUrl = null, relayModel = null } = {}) {
  const admission = loadClosedLoopAdmission(admissionId, { admissionRoot });
  const existing = processes.get(admission.admission_id);
  if (existing && existing.status === "RUNNING") throw new Error(`Admission is already running under this console: ${admission.admission_id}`);

  const args = [closedLoopCli, "closed-loop", "run", "--admission", admission.admission_id, "--admission-root", admissionRoot];
  if (admission.execution_mode === "completion-driven") args.push("--until-complete");
  if (relayUrl) args.push("--relay-url", relayUrl);
  if (relayModel) args.push("--relay-model", relayModel);

  const child = spawn(process.execPath, args, {
    cwd: admission.codex_runtime_binding?.working_directory || process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });
  const record = {
    child,
    status: "RUNNING",
    started_at: new Date().toISOString(),
    ended_at: null,
    exit_code: null,
    signal: null,
    log: [],
  };
  processes.set(admission.admission_id, record);
  child.stdout.on("data", (chunk) => appendLog(record, "stdout", chunk));
  child.stderr.on("data", (chunk) => appendLog(record, "stderr", chunk));
  child.on("error", (error) => appendLog(record, "error", error.stack || error.message || error));
  child.on("exit", (code, signal) => {
    record.status = "EXITED";
    record.ended_at = new Date().toISOString();
    record.exit_code = Number.isInteger(code) ? code : null;
    record.signal = signal || null;
  });
  return processSnapshot(admission.admission_id);
}

export function stopAdmission(admissionId) {
  const record = processes.get(admissionId);
  if (!record || record.status !== "RUNNING") throw new Error("No running console-owned process for this admission.");
  const sent = record.child.kill("SIGTERM");
  if (!sent) throw new Error("Failed to request process termination.");
  record.status = "STOP_REQUESTED";
  appendLog(record, "console", "Stop requested by operator.");
  return processSnapshot(admissionId);
}

const PAGE = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EPHEMERA Console</title>
<style>
:root{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:#111;background:#f5f5f2}*{box-sizing:border-box}body{margin:0}header{padding:18px 24px;border-bottom:1px solid #bbb;background:#fff;display:flex;justify-content:space-between;align-items:center}h1{font-size:18px;margin:0}.muted{color:#666}.wrap{display:grid;grid-template-columns:minmax(320px,430px) 1fr;min-height:calc(100vh - 62px)}aside{border-right:1px solid #bbb;background:#fff;overflow:auto}.run{padding:14px 16px;border-bottom:1px solid #ddd;cursor:pointer}.run:hover,.run.active{background:#efefe8}.phase{font-weight:700}.detail{padding:24px;overflow:auto}.grid{display:grid;grid-template-columns:150px minmax(0,1fr);gap:8px 16px;margin:18px 0}.actions{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0}button{font:inherit;padding:8px 12px;border:1px solid #888;background:#fff;cursor:pointer}button:hover{background:#eee}button:disabled{opacity:.4;cursor:not-allowed}pre{white-space:pre-wrap;word-break:break-word;background:#111;color:#eee;padding:14px;min-height:220px;max-height:46vh;overflow:auto}.ok{color:#08783b}.bad{color:#a31313}@media(max-width:850px){.wrap{grid-template-columns:1fr}aside{border-right:0;border-bottom:1px solid #bbb;max-height:38vh}}
</style>
</head>
<body>
<header><h1>EPHEMERA Console — current Dev Exec closed loop</h1><span id="stamp" class="muted"></span></header>
<div class="wrap"><aside id="runs"></aside><main class="detail" id="detail"><span class="muted">Admissionを選択してください。</span></main></div>
<script>
let rows=[];let selected=null;
const e=(s)=>String(s??'');
function esc(v){return e(v).replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
async function api(path,options){const r=await fetch(path,options);const data=await r.json();if(!r.ok)throw new Error(data.error||('HTTP '+r.status));return data;}
function renderList(){const root=document.getElementById('runs');root.innerHTML=rows.length?rows.map(r=>'<div class="run '+(r.admission_id===selected?'active':'')+'" data-id="'+esc(r.admission_id)+'"><div class="phase">'+esc(r.phase)+'</div><div>'+esc(r.goal||r.mission_id||r.admission_id)+'</div><div class="muted">round '+esc(r.round_index)+' · '+esc(r.supervisor_decision||'—')+'</div></div>').join(''):'<div class="run muted">Admissionなし</div>';root.querySelectorAll('[data-id]').forEach(x=>x.onclick=()=>{selected=x.dataset.id;renderList();renderDetail();});}
function renderDetail(){const r=rows.find(x=>x.admission_id===selected);const root=document.getElementById('detail');if(!r){root.innerHTML='<span class="muted">Admissionを選択してください。</span>';return;}const p=r.process;const log=(p?.log||[]).map(x=>'['+x.at+'] '+x.source+'> '+x.line).join('\n');root.innerHTML='<h2>'+esc(r.goal||r.mission_id)+'</h2><div class="phase '+(r.phase==='COMPLETE'?'ok':'')+'">'+esc(r.phase)+'</div><div class="grid"><div class="muted">Mission</div><div>'+esc(r.mission_id)+'</div><div class="muted">Task</div><div>'+esc(r.current_task||r.task_id)+'</div><div class="muted">Thread</div><div>'+esc(r.thread_id)+'</div><div class="muted">Round</div><div>'+esc(r.round_index)+'</div><div class="muted">Supervisor</div><div>'+esc(r.supervisor_decision||'—')+'</div><div class="muted">Runtime</div><div>'+esc(r.working_directory||'—')+'</div><div class="muted">Process</div><div>'+esc(p?p.status:'not console-owned')+(p?.pid?' · PID '+esc(p.pid):'')+'</div></div><div class="actions"><button id="start">開始 / 再開</button><button id="stop" '+(!p||!['RUNNING','STOP_REQUESTED'].includes(p.status)?'disabled':'')+'>停止</button><button id="refresh">更新</button></div><pre>'+esc(log||JSON.stringify(r.state,null,2))+'</pre>';document.getElementById('start').onclick=()=>act('run');document.getElementById('stop').onclick=()=>act('stop');document.getElementById('refresh').onclick=load;}
async function act(name){try{await api('/api/'+name,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({admission_id:selected})});await load();}catch(err){alert(err.message);}}
async function load(){try{rows=(await api('/api/admissions')).admissions;if(selected&&!rows.some(r=>r.admission_id===selected))selected=null;if(!selected&&rows[0]?.admission_id)selected=rows[0].admission_id;document.getElementById('stamp').textContent=new Date().toLocaleTimeString();renderList();renderDetail();}catch(err){document.getElementById('detail').innerHTML='<span class="bad">'+esc(err.message)+'</span>';}}
load();setInterval(load,2000);
</script>
</body></html>`;

export function createConsoleServer({ admissionRoot }) {
  return http.createServer(async (req, res) => {
    try {
      const remote = req.socket.remoteAddress || "";
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) {
        json(res, 403, { error: "loopback only" });
        return;
      }
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/") {
        html(res, PAGE);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/admissions") {
        json(res, 200, { admissions: listAdmissions(admissionRoot) });
        return;
      }
      if (req.method === "POST" && ["/api/run", "/api/stop"].includes(url.pathname)) {
        const body = await readJsonBody(req);
        if (typeof body.admission_id !== "string" || !body.admission_id) throw new Error("admission_id is required.");
        const result = url.pathname === "/api/run"
          ? startAdmission(body.admission_id, { admissionRoot })
          : stopAdmission(body.admission_id);
        json(res, 200, result);
        return;
      }
      json(res, 404, { error: "not found" });
    } catch (error) {
      json(res, 400, { error: String(error.message || error) });
    }
  });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const server = createConsoleServer(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, resolve);
  });
  process.stdout.write(`[devexec console] http://${options.host}:${options.port}\n`);
  process.stdout.write(`[devexec console] admissions=${options.admissionRoot}\n`);
  process.stdout.write("[devexec console] Ctrl+C closes the console. Running child loops receive SIGTERM.\n");
  const shutdown = () => {
    for (const record of processes.values()) {
      if (record.status === "RUNNING") record.child.kill("SIGTERM");
    }
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`[devexec console] ERROR: ${error.message || error}\n`);
    process.exitCode = 1;
  });
}
