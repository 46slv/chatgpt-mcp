#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { DEFAULT_CLOSED_LOOP_ADMISSION_ROOT, loadClosedLoopAdmission } from "./devexec-closed-loop-facade.mjs";
import { createClosedLoopStateStore } from "./devexec-closed-loop.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const closedLoopCli = path.join(here, "devexec-closed-loop-cli.mjs");
const MAX_LOG_LINES = 500;
const processes = new Map();
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

function parseArgs(argv) {
  const options = {
    host: "127.0.0.1",
    port: 4318,
    admissionRoot: process.env.DEV_EXEC_CLOSED_LOOP_ADMISSION_DIR || DEFAULT_CLOSED_LOOP_ADMISSION_ROOT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const value = argv[i + 1];
    if (token === "--port") {
      if (!/^\d+$/.test(value || "")) throw new Error("--port requires an integer.");
      options.port = Number(value);
      if (options.port < 1 || options.port > 65535) throw new Error("--port is out of range.");
      i += 1;
    } else if (token === "--admission-root") {
      if (!value || !path.isAbsolute(value)) throw new Error("--admission-root requires an absolute path.");
      options.admissionRoot = path.resolve(value);
      i += 1;
    } else if (token === "--help" || token === "-h") {
      process.stdout.write("Usage: npm run console:devexec -- [--port 4318] [--admission-root <absolute path>]\n");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  return options;
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
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
      if (Buffer.byteLength(text, "utf8") > 65536) reject(new Error("Request body too large."));
    });
    req.on("end", () => {
      try { resolve(text ? JSON.parse(text) : {}); }
      catch (error) { reject(new Error(`Invalid JSON body: ${error.message}`)); }
    });
    req.on("error", reject);
  });
}

function stateFor(admission) {
  try {
    return createClosedLoopStateStore({ stateDir: admission.state_dir }).load(admission.loop_id);
  } catch (error) {
    return { status: "NOT_STARTED_OR_UNREADABLE", error: String(error.message || error) };
  }
}

function processFor(admissionId) {
  const record = processes.get(admissionId);
  if (!record) return null;
  return {
    pid: record.child.pid || null,
    status: record.status,
    started_at: record.started_at,
    ended_at: record.ended_at,
    exit_code: record.exit_code,
    signal: record.signal,
    log: record.log.slice(-MAX_LOG_LINES),
  };
}

function admissionFiles(root) {
  const dir = path.join(root, "admissions-v1");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(dir, entry.name));
}

export function listAdmissions(admissionRoot) {
  const rows = admissionFiles(admissionRoot).map((file) => {
    try {
      const admission = loadClosedLoopAdmission(file, { admissionRoot });
      const state = stateFor(admission);
      return {
        admission_id: admission.admission_id,
        mission_id: admission.mission_id,
        task_id: admission.task_id,
        goal: admission.goal || null,
        current_task: admission.current_task || null,
        execution_mode: admission.execution_mode,
        thread_id: admission.codex_continuation_binding?.thread_id || null,
        working_directory: admission.codex_continuation_binding?.working_directory || null,
        created_at: admission.created_at,
        updated_at: state?.updated_at || admission.updated_at,
        phase: state?.phase || state?.status || "NOT_STARTED",
        round_index: state?.round_index ?? 0,
        supervisor_decision: state?.supervisor_decision ?? null,
        semantic_terminal: state?.semantic_terminal ?? false,
        terminal_reason: state?.terminal_reason ?? null,
        error_code: state?.error_code ?? null,
        state,
        process: processFor(admission.admission_id),
      };
    } catch (error) {
      return { file, phase: "UNREADABLE", error: String(error.message || error) };
    }
  });
  rows.sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")));
  return rows;
}

function appendLog(record, source, chunk) {
  const at = new Date().toISOString();
  for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) record.log.push({ at, source, line });
  if (record.log.length > MAX_LOG_LINES * 2) record.log.splice(0, record.log.length - MAX_LOG_LINES);
}

export function startAdmission(admissionId, { admissionRoot } = {}) {
  const admission = loadClosedLoopAdmission(admissionId, { admissionRoot });
  const existing = processes.get(admission.admission_id);
  if (existing && ["RUNNING", "STOP_REQUESTED"].includes(existing.status)) throw new Error("Admission is already running under this console.");

  const args = [closedLoopCli, "closed-loop", "run", "--admission", admission.admission_id, "--admission-root", admissionRoot];
  if (admission.execution_mode === "completion-driven") args.push("--until-complete");
  const child = spawn(process.execPath, args, {
    cwd: admission.codex_continuation_binding?.working_directory || process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });
  const record = { child, status: "RUNNING", started_at: new Date().toISOString(), ended_at: null, exit_code: null, signal: null, log: [] };
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
  return processFor(admission.admission_id);
}

export function stopAdmission(admissionId) {
  const record = processes.get(admissionId);
  if (!record || record.status !== "RUNNING") throw new Error("Only a loop started by this console can be stopped safely.");
  if (!record.child.kill("SIGTERM")) throw new Error("Failed to request process termination.");
  record.status = "STOP_REQUESTED";
  appendLog(record, "console", "Operator requested stop.");
  return processFor(admissionId);
}

const PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EPHEMERA Console</title><style>
:root{font-family:Consolas,ui-monospace,monospace;color:#111;background:#f3f3ef}*{box-sizing:border-box}body{margin:0}header{height:58px;padding:0 20px;background:white;border-bottom:1px solid #bbb;display:flex;align-items:center;justify-content:space-between}h1{font-size:17px;margin:0}.layout{display:grid;grid-template-columns:390px 1fr;height:calc(100vh - 58px)}aside{background:white;border-right:1px solid #bbb;overflow:auto}.item{padding:13px 15px;border-bottom:1px solid #ddd;cursor:pointer}.item.active,.item:hover{background:#ebebe5}.phase{font-weight:700}.muted{color:#666}.main{padding:22px;overflow:auto}.kv{display:grid;grid-template-columns:140px 1fr;gap:7px 14px;margin:16px 0}.buttons{display:flex;gap:8px;margin:16px 0}button{font:inherit;padding:8px 12px;background:white;border:1px solid #888;cursor:pointer}button:disabled{opacity:.35}pre{background:#111;color:#eee;padding:14px;white-space:pre-wrap;word-break:break-word;max-height:46vh;overflow:auto}.good{color:#08783b}.bad{color:#a31313}@media(max-width:800px){.layout{grid-template-columns:1fr;display:block}aside{max-height:36vh;border-right:0;border-bottom:1px solid #bbb}.main{height:64vh}}
</style></head><body><header><h1>EPHEMERA Console — Dev Exec ChatGPT + Local</h1><span id="time" class="muted"></span></header><div class="layout"><aside id="list"></aside><main id="main" class="main">loading...</main></div><script>
let rows=[],selected=null;const esc=v=>String(v??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function req(url,opt){const r=await fetch(url,opt);const d=await r.json();if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d}
function list(){const n=document.getElementById('list');n.innerHTML=rows.length?rows.map(r=>'<div class="item '+(r.admission_id===selected?'active':'')+'" data-id="'+esc(r.admission_id)+'"><div class="phase">'+esc(r.phase)+'</div><div>'+esc(r.goal||r.mission_id||r.admission_id)+'</div><div class="muted">round '+esc(r.round_index)+' · '+esc(r.supervisor_decision||'—')+'</div></div>').join(''):'<div class="item muted">closed-loop admission がありません</div>';n.querySelectorAll('[data-id]').forEach(x=>x.onclick=()=>{selected=x.dataset.id;list();detail()})}
function detail(){const r=rows.find(x=>x.admission_id===selected),n=document.getElementById('main');if(!r){n.innerHTML='<span class="muted">runを選択してください</span>';return}const p=r.process,log=(p?.log||[]).map(x=>'['+x.at+'] '+x.source+'> '+x.line).join('\n');n.innerHTML='<h2>'+esc(r.goal||r.mission_id)+'</h2><div class="phase '+(r.phase==='COMPLETE'?'good':'')+'">'+esc(r.phase)+'</div><div class="kv"><span class="muted">Mission</span><span>'+esc(r.mission_id)+'</span><span class="muted">Task</span><span>'+esc(r.current_task||r.task_id)+'</span><span class="muted">Thread</span><span>'+esc(r.thread_id)+'</span><span class="muted">Round</span><span>'+esc(r.round_index)+'</span><span class="muted">Supervisor</span><span>'+esc(r.supervisor_decision||'—')+'</span><span class="muted">Working dir</span><span>'+esc(r.working_directory||'—')+'</span><span class="muted">Process</span><span>'+esc(p?p.status:'external / not console-owned')+(p?.pid?' · PID '+esc(p.pid):'')+'</span></div><div class="buttons"><button id="run">開始 / 再開</button><button id="stop" '+(!p||p.status!=='RUNNING'?'disabled':'')+'>停止</button><button id="refresh">更新</button></div><pre>'+esc(log||JSON.stringify(r.state,null,2))+'</pre>';document.getElementById('run').onclick=()=>act('run');document.getElementById('stop').onclick=()=>act('stop');document.getElementById('refresh').onclick=load}
async function act(action){try{await req('/api/'+action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({admission_id:selected})});await load()}catch(e){alert(e.message)}}
async function load(){try{rows=(await req('/api/admissions')).admissions;if(selected&&!rows.some(r=>r.admission_id===selected))selected=null;if(!selected&&rows[0]?.admission_id)selected=rows[0].admission_id;document.getElementById('time').textContent=new Date().toLocaleTimeString();list();detail()}catch(e){document.getElementById('main').innerHTML='<span class="bad">'+esc(e.message)+'</span>'}}
load();setInterval(load,2000);
</script></body></html>`;

export function createConsoleServer({ admissionRoot }) {
  return http.createServer(async (req, res) => {
    try {
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress || "")) return sendJson(res, 403, { error: "loopback only" });
      if (!isLoopbackHostHeader(req.headers.host)) return sendJson(res, 403, { error: "loopback Host required" });
      if (req.method === "POST" && !isAllowedMutatingOrigin(req.headers.origin)) return sendJson(res, 403, { error: "loopback Origin required for browser mutation" });
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "x-content-type-options": "nosniff" });
        return res.end(PAGE);
      }
      if (req.method === "GET" && url.pathname === "/api/admissions") return sendJson(res, 200, { admissions: listAdmissions(admissionRoot) });
      if (req.method === "POST" && ["/api/run", "/api/stop"].includes(url.pathname)) {
        const body = await readBody(req);
        if (typeof body.admission_id !== "string" || !body.admission_id) throw new Error("admission_id is required.");
        const result = url.pathname === "/api/run" ? startAdmission(body.admission_id, { admissionRoot }) : stopAdmission(body.admission_id);
        return sendJson(res, 200, result);
      }
      return sendJson(res, 404, { error: "not found" });
    } catch (error) {
      return sendJson(res, 400, { error: String(error.message || error) });
    }
  });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const server = createConsoleServer(options);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(options.port, options.host, resolve); });
  process.stdout.write(`[devexec console] http://${options.host}:${options.port}\n`);
  process.stdout.write(`[devexec console] admissions=${options.admissionRoot}\n`);
  const shutdown = () => {
    for (const record of processes.values()) if (record.status === "RUNNING") record.child.kill("SIGTERM");
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main().catch((error) => { process.stderr.write(`[devexec console] ERROR: ${error.message || error}\n`); process.exitCode = 1; });
