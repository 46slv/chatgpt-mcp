#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadRegistry, resolveTarget } from "./target-registry.mjs";
import { loadAndClassifyRunState, loadAndInspectReceiptAwarePending, reconcileReceiptAwarePending, verifyEventJournal } from "./devexec-recovery.mjs";
import { classifySelfRecovery } from "./devexec-self-recovery.mjs";
import { queueTerminalStopAlert } from "./devexec-stop-alert-runtime.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const targetCli = path.join(here, "devexec-target.mjs");
const localAgentCli = path.join(here, "local-agent-facade.mjs");
const goalCli = path.join(here, "devexec-goal.mjs");
const runner = process.env.DEV_EXEC_RUNNER_PATH || path.join(here, "dev-exec-loop.mjs");
const BASE = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const STATE_DIR = process.env.DEV_EXEC_STATE_DIR || path.join(BASE, "ChatGPTMCPProbe", "dev-exec-state");
const RUNS_DIR = process.env.DEV_EXEC_RUNS_DIR || path.join(BASE, "ChatGPTMCPProbe", "dev-exec-runs");
const TERMINAL_PHASES = new Set(["COMPLETE", "FAILED", "NEEDS_HUMAN", "CANCELLED"]);

function validateRunId(runId) {
 if (!runId || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(runId) || runId.includes("..") || runId.includes("/") || runId.includes("\\") || path.isAbsolute(runId)) {
 throw new Error("Invalid run id.");
 }
 return runId;
}

function loadRunState(runId) {
 const id = validateRunId(runId);
 const file = path.join(STATE_DIR, id + ".json");
 if (!fs.existsSync(file)) {
 throw new Error("Run state not found: " + id);
 }
 const state = JSON.parse(fs.readFileSync(file, "utf8"));
 if (state.run_id !== id) {
 throw new Error("Run state id mismatch.");
 }
 return state;
}

function makeContinueRunId() {
 return validateRunId(process.env.DEV_EXEC_CONTINUE_RUN_ID || ("DEV-EXEC-CONTINUE-" + Date.now() + "-" + crypto.randomBytes(3).toString("hex")));
}

function runNode(script, args, env = process.env) {
 return new Promise((resolve, reject) => {
 const child = spawn(process.execPath, [script, ...args], {
 stdio: "inherit",
 env,
 });
 child.on("error", reject);
 child.on("exit", (code) => {
 resolve(Number.isInteger(code) ? code : 1);
 });
 });
}

function appendSelfRecoveryEvent(runId,event){const dir=path.join(RUNS_DIR,runId);fs.mkdirSync(dir,{recursive:true});fs.appendFileSync(path.join(dir,"self-recovery.jsonl"),JSON.stringify({protocol:"devexec.self-recovery.event",schema_version:1,run_id:runId,at:new Date().toISOString(),...event})+"\n","utf8");}
async function runWithSelfRecovery(initialRunId,initialEnv,targetAlias){let runId=initialRunId;let env={...initialEnv};const maxDepth=Number.parseInt(process.env.DEV_EXEC_MAX_SELF_RECOVERY_DEPTH||"3",10);while(true){const code=await runNode(runner,[],env);if(code===0)return 0;let state;try{state=loadRunState(runId);}catch{return code;}const depth=Number.parseInt(env.DEV_EXEC_SELF_RECOVERY_DEPTH||"0",10);const recovery=classifySelfRecovery({type:state.stop_type,pending:!!state.pending,depth,maxDepth});state.self_recovery={...(state.self_recovery||{}),last_checked_at:new Date().toISOString(),depth,recoverable:recovery.recoverable,reason:recovery.reason};fs.writeFileSync(path.join(STATE_DIR,runId+".json"),JSON.stringify(state,null,2)+"\n","utf8");if(!recovery.recoverable){appendSelfRecoveryEvent(runId,{type:state.stop_type||null,depth,recoverable:false,reason:recovery.reason,pending:!!state.pending});const missionId=env.DEV_EXEC_MISSION_ID||state.mission_id||env.DEV_EXEC_PARENT_MISSION_ID||env.DEV_EXEC_PARENT_RUN_ID||runId;const queueDir=path.join(BASE,"ChatGPTMCPProbe","stop-alert-queue","pending");const q=queueTerminalStopAlert({state,recovery,run_id:runId,mission_id:missionId,machine:process.env.COMPUTERNAME||os.hostname(),project_root:process.cwd(),queue_dir:queueDir});if(q?.alert){const runDir=path.join(RUNS_DIR,runId);fs.mkdirSync(runDir,{recursive:true});fs.writeFileSync(path.join(runDir,"stop-alert.json"),JSON.stringify(q.alert,null,2)+"\n","utf8");}return code;}const childRunId=makeContinueRunId();appendSelfRecoveryEvent(runId,{type:state.stop_type,depth,recoverable:true,reason:recovery.reason,strategy:recovery.strategy,next_depth:recovery.nextDepth,child_run_id:childRunId});env={...env,DEV_EXEC_RUN_ID:childRunId,DEV_EXEC_PARENT_RUN_ID:runId,DEV_EXEC_CONTINUE_FROM_PHASE:state.phase,DEV_EXEC_SELF_RECOVERY_DEPTH:String(recovery.nextDepth),DEV_EXEC_TARGET_ALIAS:targetAlias,DEV_EXEC_PURPOSE:"Automatically recover Dev Exec run "+runId+".",DEV_EXEC_TARGET:"Continue recoverable terminal parent run "+runId+" ("+state.stop_type+"). Preserve parent as immutable history."};process.stdout.write("[devexec] self-recovery parent="+runId+" type="+state.stop_type+" depth="+recovery.nextDepth+"/"+maxDepth+" child="+childRunId+"\n");runId=childRunId;}}
function usage() {
 process.stderr.write([
 "Usage:",
 " devexec target list",
 " devexec target current",
 " devexec target set <alias> <chat-url>",
 " devexec target register <alias> <chat-url>",
 " devexec target use <alias>",
 " devexec target capture <alias>",
 " devexec goal <goal> [--target <alias>]",
 " devexec agent start <goal>",
 " devexec agent resume <local-agent-run-id>",
 " devexec agent status <local-agent-run-id>",
 " devexec run [--target <alias>]",
 " devexec continue <run-id> [--target <alias>]",
 " devexec recover inspect <run-id>",
 " devexec recover verify-journal <run-id>",
 "",
 ].join("\n"));
}

const args = process.argv.slice(2);
const command = args.shift();

if (command === "target") {
 const code = await runNode(targetCli, args);
 process.exit(code);
}

if (command === "goal") {
 const code = await runNode(goalCli, args, process.env);
 process.exit(code);
}

if (command === "agent") {
 const subcommand = args[0];
 if (!["start", "resume", "status"].includes(subcommand)) throw new Error("agent requires start, resume, or status.");
 const code = await runNode(localAgentCli, args, process.env);
 process.exit(code);
}

if (command === "recover") {
 const subcommand = args.shift();
 if (!["inspect", "reconcile", "verify-journal"].includes(subcommand)) throw new Error("recover requires inspect, reconcile, or verify-journal <run-id>.");
 const runId = validateRunId(args.shift());
 if (args.length !== 0) throw new Error("Unknown recover argument: " + args[0]);
 const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
 const runBase = process.env.DEV_EXEC_RUNS_DIR || path.join(base, "ChatGPTMCPProbe", "dev-exec-runs");
 if (subcommand === "inspect") {
 const result = loadAndInspectReceiptAwarePending(STATE_DIR, runBase, runId);
 process.stdout.write(JSON.stringify(result, null, 2) + String.fromCharCode(10));
 process.exit(0);
 }
 if (subcommand === "reconcile") {
 const result = reconcileReceiptAwarePending(STATE_DIR, runBase, runId);
 process.stdout.write(JSON.stringify(result, null, 2) + String.fromCharCode(10));
 process.exit(0);
 }
 const result = verifyEventJournal(path.join(runBase, runId), runId);
 process.stdout.write(JSON.stringify(result, null, 2) + String.fromCharCode(10));
 process.exit(result.valid ? 0 : 3);
}

if (command === "run") {
 let alias = null;
 for (let i = 0; i < args.length; i += 1) {
 if (args[i] === "--target") {
 alias = args[i + 1] || null;
 if (!alias) throw new Error("--target requires an alias.");
 i += 1;
 continue;
 }
 throw new Error("Unknown run argument: " + args[i]);
 }

 const registry = loadRegistry();
 const resolved = resolveTarget({ explicitTarget: alias, cwd: process.cwd(), registry });
 process.stdout.write("[devexec] target=" + resolved.target_id + " source=" + resolved.source + " conversation=" + resolved.conversation_id + "\n");
 const env = { ...process.env };
 if (alias) env.DEV_EXEC_TARGET_ALIAS = alias;
 const initialRunId=env.DEV_EXEC_RUN_ID||("DEV-EXEC-"+Date.now()); env.DEV_EXEC_RUN_ID=initialRunId;
 const code = await runWithSelfRecovery(initialRunId, env, resolved.target_id);
 process.exit(code);
}

if (command === "continue") {
 const parentRunId = args.shift();
 if (!parentRunId) throw new Error("continue requires a parent run id.");

 let alias = null;
 for (let i = 0; i < args.length; i += 1) {
 if (args[i] === "--target") {
 alias = args[i + 1] || null;
 if (!alias) throw new Error("--target requires an alias.");
 i += 1;
 continue;
 }
 throw new Error("Unknown continue argument: " + args[i]);
 }

 const parent = loadRunState(parentRunId);
 if (!TERMINAL_PHASES.has(parent.phase)) {
 throw new Error("Run is not terminal: " + parentRunId + " phase=" + parent.phase);
 }
 if (parent.pending) {
 throw new Error("Run has ambiguous pending execution: " + parentRunId);
 }

 const targetAlias = alias || (parent.target && parent.target.target_id) || null;
 if (!targetAlias) {
 throw new Error("Parent run has no frozen target alias; pass --target <alias>.");
 }

 const registry = loadRegistry();
 const resolved = resolveTarget({ explicitTarget: targetAlias, cwd: process.cwd(), registry });
 const childRunId = makeContinueRunId();
 const priorStep = parent.step == null ? 0 : parent.step;
 const env = {
 ...process.env,
 DEV_EXEC_RUN_ID: childRunId,
 DEV_EXEC_PARENT_RUN_ID: parentRunId,
 DEV_EXEC_CONTINUE_FROM_PHASE: parent.phase,
 DEV_EXEC_TARGET_ALIAS: targetAlias,
 DEV_EXEC_PURPOSE: "Continue terminal Dev Exec run " + parentRunId + ".",
 DEV_EXEC_TARGET: "Continue from terminal parent run " + parentRunId + " (" + parent.phase + ") at prior step " + priorStep + ". Preserve the parent as immutable history and create new work only in child run " + childRunId + ".",
 };

 process.stdout.write("[devexec] continue parent=" + parentRunId + " phase=" + parent.phase + " child=" + childRunId + " target=" + resolved.target_id + " conversation=" + resolved.conversation_id + "\n");
 const code = await runWithSelfRecovery(childRunId, env, targetAlias);
 process.exit(code);
}

usage();
process.exit(2);


