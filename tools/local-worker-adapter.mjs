#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeLocalWorkerEscalation } from "./local-worker-cloud-handoff.mjs";
import { consumeLocalWorkerRepair } from "./local-worker-supervisor-repair.mjs";
import { buildPlannerPrompt, parsePlannerText } from "./local-worker-planner-protocol.mjs";
import { runIterativeLocalWorker } from "./local-worker-iterative-runner.mjs";
import { runLocalWorkerResume } from "./local-worker-resume-runtime.mjs";
import { inspectLocalPlannerContext, recordContextDecision, buildRotatedPlannerPrompt } from "./local-worker-context-runtime.mjs";
import { persistSessionCheckpoint, appendSessionEvent } from "./local-worker-session-checkpoint.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadRegistry, resolveTarget } from "./target-registry.mjs";
import { consultationEnabled, createChatgptReplyAdapter, createConsultationRunner } from "./devexec-consultation.mjs";
const BASE = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const STATE_DIR = path.join(BASE, "ChatGPTMCPProbe", "local-worker-runs");
const LMS = process.env.LOCAL_WORKER_LMS || "lms.exe";
const MODEL = process.env.LOCAL_WORKER_MODEL || "note-worker";
const EXECUTOR_ROOT = process.env.LOCAL_WORKER_EXECUTOR_ROOT || String.raw`D:\Documents\LocalExecutorRepo`;
const PROBE_ROOT = process.env.LOCAL_WORKER_PROBE_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE = process.env.LOCAL_WORKER_PROFILE || path.join(EXECUTOR_ROOT, "profiles", process.env.LOCAL_WORKER_ALLOW_WRITE === "1" ? "chatgpt-mcp-probe-workspace-write.json" : "chatgpt-mcp-probe-readonly.json");
const MODEL_API = path.join(EXECUTOR_ROOT, "model_api.py");
const PYTHON = process.env.LOCAL_WORKER_PYTHON || "python";
const MAX_PLANNER_ROUNDS = Number.parseInt(process.env.LOCAL_WORKER_MAX_PLANNER_ROUNDS || "3", 10);
const PLANNER_TIMEOUT_MS = Number.parseInt(process.env.LOCAL_WORKER_PLANNER_TIMEOUT_MS || "75000", 10);
const PLANNER_ATTEMPTS = Number.parseInt(process.env.LOCAL_WORKER_PLANNER_ATTEMPTS || "2", 10);
const ALLOW_WRITE = process.env.LOCAL_WORKER_ALLOW_WRITE === "1";
const CONSULTATION_OPT_IN = consultationEnabled(process.env);
const CONSULTATION_TARGET_ALIAS = process.env.DEV_EXEC_CHATGPT_CONSULT_TARGET_ALIAS || process.env.DEV_EXEC_TARGET_ALIAS || null;
const CONSULTATION_STATE_DIR = process.env.DEV_EXEC_CONSULTATION_STATE_DIR || path.join(BASE, "ChatGPTMCPProbe", "consultation-state");
const CONTEXT_WINDOW = Number.parseInt(process.env.LOCAL_WORKER_CONTEXT_WINDOW || "8192", 10);
const ALLOWED = new Set(["git_branch_current", "git_status_short", "git_diff_name_only", "path_exists", "read_file", "file_sha256", ...(ALLOW_WRITE ? ["write_text_file"] : [])]);
function exactKeys(v,e){return !!v&&typeof v==="object"&&!Array.isArray(v)&&JSON.stringify(Object.keys(v).sort())===JSON.stringify([...e].sort());}
function stripAnsi(t){return String(t||"").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g,"").replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g,"");}
function cleanModel(raw){let v=stripAnsi(raw).trim();const i=v.lastIndexOf("</think>");if(i>=0)v=v.slice(i+8).trim();const a=v.indexOf("{");const b=v.lastIndexOf("}");if(a>=0&&b>=a)v=v.slice(a,b+1);return v.trim();}
function runId(){return `LW-${new Date().toISOString().replace(/[-:.TZ]/g,"")}-${crypto.randomBytes(3).toString("hex")}`;}
function validateWorkerRunId(id){if(typeof id!=="string"||!/^LW-[A-Za-z0-9_-]+$/.test(id)||id.includes("..")||path.isAbsolute(id))throw new Error("invalid run_id");return id;}
function validateExternalRunId(id){if(typeof id!=="string"||!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)||id.includes("..")||path.isAbsolute(id))throw new Error("invalid external run id");return id;}
function repairPath(){if(!process.env.DEV_EXEC_RUN_ID)return null;return path.join(BASE,"ChatGPTMCPProbe","dev-exec-runs",validateExternalRunId(process.env.DEV_EXEC_RUN_ID),"local-worker-repair.json");}
function statePath(id){return path.join(STATE_DIR,`${validateWorkerRunId(id)}.json`);}
function save(s){fs.mkdirSync(STATE_DIR,{recursive:true});const d=statePath(s.run_id);const t=`${d}.tmp-${process.pid}`;fs.writeFileSync(t,JSON.stringify(s,null,2)+"\n","utf8");fs.renameSync(t,d);}
function load(id){return JSON.parse(fs.readFileSync(statePath(id),"utf8"));}
function runProcess(command,args,options={}){const r=spawnSync(command,args,{cwd:options.cwd,input:options.input,encoding:"utf8",windowsHide:true,shell:false,timeout:options.timeout||180000,maxBuffer:2*1024*1024,env:{...process.env,PYTHONUTF8:"1"}});if(r.error)throw r.error;if(r.status!==0)throw new Error(`${command} exit=${r.status}\n${r.stderr||r.stdout}`);return r.stdout||"";}
function askPlannerDecision(mission,evidence=[],round=1,maxRounds=3,workerState=null){
 let prompt=buildPlannerPrompt({mission,evidence,round,maxRounds,allowWrite:ALLOW_WRITE,consultationEnabled:CONSULTATION_OPT_IN&&!!CONSULTATION_TARGET_ALIAS});
 if(workerState){const inspection=inspectLocalPlannerContext({run_id:workerState.run_id,mission,prompt,actions:evidence,model:MODEL,profile:PROFILE,working_root:PROBE_ROOT,round,contextWindow:CONTEXT_WINDOW});recordContextDecision(workerState,inspection);if(inspection.checkpoint){workerState.context_checkpoint_file=persistSessionCheckpoint(STATE_DIR,inspection.checkpoint);workerState.context_event_file=appendSessionEvent(STATE_DIR,workerState.run_id,{type:"CONTEXT_"+inspection.decision,reason:inspection.reason,utilization:inspection.utilization,estimated_tokens:inspection.estimated_tokens,context_window:inspection.context_window,checkpoint_file:workerState.context_checkpoint_file});}if(inspection.decision==="ROTATE"){prompt=buildRotatedPlannerPrompt({fixedContract:"bounded local planner; deterministic Local Executor actions only; allowed actions: git_branch_current args {}; git_status_short args {}; git_diff_name_only args {}; path_exists args {path:string}; read_file args {path:string,max_bytes?:integer}; file_sha256 args {path:string}"+(ALLOW_WRITE?"; write_text_file args {path:string,content:string,expected_sha256:string}":"")+(CONSULTATION_OPT_IN&&CONSULTATION_TARGET_ALIAS?"; optional REQUEST_CONSULTATION {type,prompt} ordinary text only":"")+"; output exactly {type:COMPLETE,summary:string}, {type:REQUEST_ACTIONS,actions:[{action:string,args:object}], or REQUEST_CONSULTATION; evidence is authoritative",inspection,latestInstruction:"continue the same mission and return the next planner decision"});workerState.context_governor.rotated_prompt_tokens=Math.ceil(Buffer.byteLength(prompt,"utf8")/3.5);}save(workerState);}
 let raw=null;
 let lastError=null;
 for(let attempt=1;attempt<=PLANNER_ATTEMPTS;attempt++){
 try{raw=runProcess(LMS,["chat",MODEL,"-p",prompt,"--reasoning","off","--dont-fetch-catalog","-y","--ttl","600"],{timeout:PLANNER_TIMEOUT_MS});lastError=null;break;}
 catch(error){lastError=error;if(error?.code!=="ETIMEDOUT"&& !String(error?.message||error).includes("ETIMEDOUT"))throw error;}
 }
 if(lastError)throw lastError;
 const cleaned=cleanModel(raw);
 return parsePlannerText(cleaned,{allowWrite:ALLOW_WRITE,allowConsultation:CONSULTATION_OPT_IN&&!!CONSULTATION_TARGET_ALIAS});
}
function askPlanner(mission){
 const decision=askPlannerDecision(mission,[],1,1);
 if(decision.type!=="REQUEST_ACTIONS")return [];
 return decision.actions;
}
function callExecutor(action,args,requestId){const request=JSON.stringify({schema_version:1,request_id:requestId,action,args});const r=spawnSync(PYTHON,[MODEL_API,"--profile",PROFILE],{cwd:EXECUTOR_ROOT,input:request,encoding:"utf8",windowsHide:true,shell:false,timeout:130000,maxBuffer:2*1024*1024,env:{...process.env,PYTHONUTF8:"1"}});if(r.error)throw r.error;let payload;try{payload=JSON.parse(r.stdout||"");}catch{throw new Error(`Local Executor invalid response exit=${r.status}`);}if(payload.action!==action)throw new Error("Local Executor action mismatch");if(payload.status==="UNEXPECTED")throw new Error(`Local Executor unexpected ${action}: ${payload.reason||""}`);return payload;}
async function start(mission){
 if(!mission||!mission.trim())throw new Error("mission required");
 const id=runId();
 const s={protocol:"devexec.local-worker",schema_version:1,run_id:id,backend:"lms-cli+local-executor",model:MODEL,profile:PROFILE,mission:mission,status:"RUNNING",created_at:new Date().toISOString(),actions:[],planner_rounds:0,report:null,error:null};
 save(s);
 const consult=makeConsultationCallback(id);
 try{
 const outcome=await runIterativeLocalWorker({
 mission:mission,
 actions:s.actions,
   maxRounds:MAX_PLANNER_ROUNDS,
   consult,
 plan:async function(ctx){
 s.planner_rounds=ctx.round;
 save(s);
 return askPlannerDecision(ctx.mission,ctx.evidence,ctx.round,ctx.maxRounds,s);
 },
 execute:async function(action,args,requestId){
 return callExecutor(action,args,id+"-"+requestId);
 },
 onProgress:async function(){save(s);}
 });
 s.status="DONE";
 s.error=null;
 s.report={summary:outcome.summary,evidence:s.actions};
 s.completed_at=new Date().toISOString();
 save(s);
 }catch(error){
 s.status="FAILED";
 s.error=String(error);
 s.completed_at=new Date().toISOString();
 save(s);
 if(process.env.DEV_EXEC_RUN_ID){
 try{
 const h=writeLocalWorkerEscalation(s);
 s.cloud_handoff={status:"WRITTEN",file:h.file};
 save(s);
 }catch(handoffError){
 s.cloud_handoff={status:"FAILED",error:String(handoffError)};
 save(s);
 }
 }
 }
 console.log(JSON.stringify({run_id:id,status:s.status,planner_rounds:s.planner_rounds},null,2));
 return s.status==="DONE"?0:2;
}

function makeConsultationCallback(id){
 let consultation=null;
 let fixedTarget=null;
 let targetError=null;
 if(CONSULTATION_OPT_IN&&CONSULTATION_TARGET_ALIAS){try{fixedTarget=resolveTarget({explicitTarget:CONSULTATION_TARGET_ALIAS,cwd:PROBE_ROOT,registry:loadRegistry()});}catch(error){targetError=String(error?.message||error);}}
 return async function consult(prompt,requestId){
  if(!CONSULTATION_OPT_IN||!CONSULTATION_TARGET_ALIAS)return {status:"BLOCKED",request_id:requestId,reason:"standing_opt_in_required_or_target_missing"};
  if(targetError||!fixedTarget)return {status:"BLOCKED",request_id:requestId,reason:"fixed_target_unavailable"};
  if(!consultation){
   const target=fixedTarget;
   let mcpConfig; try { mcpConfig=JSON.parse(fs.readFileSync(path.join(os.homedir(),".lmstudio","mcp.json"),"utf8")); } catch { return {status:"BLOCKED",request_id:requestId,reason:"mcp_config_unavailable"}; }
   const server=mcpConfig?.mcpServers?.["chatgpt-web-probe"];
   if(!server?.command)return {status:"BLOCKED",request_id:requestId,reason:"chatgpt_web_probe_unavailable"};
   const transport=createChatgptReplyAdapter({callTool:async(tool)=>{
    const client=new Client({name:"devexec-local-consultation",version:"1.0.0"});
    const channel=new StdioClientTransport({command:server.command,args:server.args||[],env:{...process.env,...(server.env||{}),CHATGPT_MCP_CHAT_URL:target.chat_url,DEV_EXEC_TARGET_ID:target.target_id,DEV_EXEC_TARGET_SOURCE:target.source}});
    try { await client.connect(channel); const listed=await client.listTools(); if(!listed.tools.some(x=>x.name==="chatgpt_reply"))throw new Error("chatgpt_reply unavailable"); return await client.callTool(tool); } finally { try{await client.close();}catch{} }
   }});
   consultation=createConsultationRunner({stateDir:CONSULTATION_STATE_DIR,runId:id,targetAlias:target.target_id,targetUrl:target.chat_url,transport});
  }
  return consultation.request(prompt,requestId);
 }
}
function status(id){const s=load(id);console.log(JSON.stringify({run_id:s.run_id,status:s.status,backend:s.backend,model:s.model},null,2));return 0;}
function collect(id){console.log(JSON.stringify(load(id),null,2));return 0;}
async function resume(id){const s=load(id);if(["DONE","CANCELLED"].includes(s.status)){console.log(JSON.stringify({run_id:id,status:s.status,resumed:false,reason:"terminal"},null,2));return 0;}const rf=repairPath();if(!rf){console.log(JSON.stringify({run_id:id,status:s.status,resumed:false,reason:"DEV_EXEC_RUN_ID required for supervisor repair"},null,2));return 2;}const repair=consumeLocalWorkerRepair(rf,s);if(!repair){console.log(JSON.stringify({run_id:id,status:s.status,resumed:false,reason:"supervisor repair not available",repair_file:rf},null,2));return 2;}try{s.status="RUNNING";s.error=null;s.completed_at=null;save(s);const outcome=await runLocalWorkerResume({mission:s.mission,actions:s.actions,repair,maxRounds:MAX_PLANNER_ROUNDS,plan:async ctx=>askPlannerDecision(ctx.mission,ctx.evidence,ctx.round,ctx.maxRounds,s),execute:async(action,args,requestId)=>callExecutor(action,args,id+"-RESUME-"+requestId),onProgress:async()=>save(s)});s.status="DONE";s.error=null;s.report={summary:outcome.summary,evidence:s.actions.map(x=>({action:x.action,args:x.args,status:x.result.status,stdout:x.result.stdout?.text||"",repair:x.repair===true}))};s.completed_at=new Date().toISOString();s.cloud_handoff={status:"REPAIRED",consumed_file:repair.consumed_file};save(s);if(process.env.DEV_EXEC_RUN_ID){const ef=path.join(BASE,"ChatGPTMCPProbe","dev-exec-runs",validateExternalRunId(process.env.DEV_EXEC_RUN_ID),"mission-escalation.json");if(fs.existsSync(ef)){const archived=ef+".resolved-"+Date.now();fs.renameSync(ef,archived);s.cloud_handoff.resolved_escalation_file=archived;save(s);}}console.log(JSON.stringify({run_id:id,status:s.status,resumed:true,repair_mode:repair.mode},null,2));return 0;}catch(error){s.status="FAILED";s.error=String(error?.stack||error);s.completed_at=new Date().toISOString();save(s);try{const h=writeLocalWorkerEscalation(s);s.cloud_handoff={status:"WRITTEN",file:h.file};save(s);}catch{}console.log(JSON.stringify({run_id:id,status:s.status,resumed:true,repair_mode:repair.mode},null,2));return 2;}}
function stop(id){const s=load(id);if(!["DONE","FAILED","BLOCKED","CANCELLED"].includes(s.status)){s.status="CANCELLED";s.completed_at=new Date().toISOString();save(s);}console.log(JSON.stringify({run_id:id,status:s.status},null,2));return 0;}
const [command,...rest]=process.argv.slice(2);let code=0;try{if(command==="start")code=await start(rest.join(" "));else if(command==="status")code=status(rest[0]);else if(command==="collect")code=collect(rest[0]);else if(command==="resume")code=await resume(rest[0]);else if(command==="stop")code=stop(rest[0]);else throw new Error("usage: local-worker-adapter.mjs start <mission> | status <run_id> | resume <run_id> | stop <run_id> | collect <run_id>");}catch(error){console.error(String(error?.stack||error));code=2;}process.exitCode=code;




