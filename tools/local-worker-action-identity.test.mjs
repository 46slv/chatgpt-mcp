import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {runIterativeLocalWorker} from "./local-worker-iterative-runner.mjs";
import {runLocalWorkerResume} from "./local-worker-resume-runtime.mjs";
import {consumeLocalWorkerRepair} from "./local-worker-supervisor-repair.mjs";
import {inspectLocalPlannerContext} from "./local-worker-context-runtime.mjs";

test("iterative worker persists a pending identity before execution and completes the same record", async () => {
 const actions=[];
 const snapshots=[];
 let executeSawPending=false;
 const outcome=await runIterativeLocalWorker({
  mission:"inspect",
  actions,
  maxRounds:2,
  plan:async ({round})=>round===1?{type:"REQUEST_ACTIONS",actions:[{action:"git_status_short",args:{}}]}:{type:"COMPLETE",summary:"done"},
  execute:async (_action,_args,requestId)=>{
   executeSawPending=actions.length===1&&actions[0].pending===true&&actions[0].request_id===requestId;
   return {status:"PASS",request_id:"LW-TEST-"+requestId,stdout:{text:""}};
  },
  onProgress:async ()=>snapshots.push(structuredClone(actions)),
 });
 assert.equal(outcome.status,"DONE");
 assert.equal(executeSawPending,true);
 assert.equal(snapshots[0][0].pending,true);
 assert.equal(actions[0].request_id,"R01-01-001");
 assert.equal(actions[0].executor_request_id,"LW-TEST-R01-01-001");
 assert.equal("pending" in actions[0],false);
});

test("executor exception leaves the pre-execution identity pending for reconciliation", async () => {
 const actions=[];
 await assert.rejects(
  runIterativeLocalWorker({
   mission:"inspect",
   actions,
   maxRounds:1,
   plan:async ()=>({type:"REQUEST_ACTIONS",actions:[{action:"read_file",args:{path:"README.md"}}]}),
   execute:async ()=>{throw new Error("simulated process loss after dispatch");},
   onProgress:async ()=>{},
  }),
  /simulated process loss/,
 );
 assert.equal(actions.length,1);
 assert.equal(actions[0].request_id,"R01-01-001");
 assert.equal(actions[0].pending,true);
 assert.equal(actions[0].result,undefined);
});

test("resume rejects unresolved pending action before planner or executor work", async () => {
 let planned=false;
 let executed=false;
 const actions=[{request_id:"R01-01-001",action:"git_status_short",args:{},pending:true}];
 await assert.rejects(
  runLocalWorkerResume({
   mission:"resume",
   actions,
   repair:{mode:"RETRY_PLANNER"},
   plan:async ()=>{planned=true;return {type:"COMPLETE",summary:"wrong"};},
   execute:async ()=>{executed=true;return {status:"PASS"};},
  }),
  /AMBIGUOUS_ACTION_IN_FLIGHT: R01-01-001/,
 );
 assert.equal(planned,false);
 assert.equal(executed,false);
});

test("repair action identity advances from durable action count and captures executor identity", async () => {
 const actions=[{request_id:"R01-01-001",executor_request_id:"LW-X-R01-01-001",action:"git_status_short",args:{},result:{status:"PASS"}}];
 const outcome=await runLocalWorkerResume({
  mission:"resume",
  actions,
  repair:{mode:"EXECUTE_TYPED_ACTIONS",next_actions:[{action:"git_branch_current",args:{}}]},
  maxRounds:1,
  plan:async ()=>({type:"COMPLETE",summary:"done"}),
  execute:async (_action,_args,requestId)=>({status:"PASS",request_id:"LW-X-RESUME-"+requestId,stdout:{text:"main"}}),
  onProgress:async ()=>{},
 });
 assert.equal(outcome.status,"DONE");
 assert.equal(actions[1].request_id,"REPAIR-002");
 assert.equal(actions[1].executor_request_id,"LW-X-RESUME-REPAIR-002");
 assert.equal(actions[1].repair,true);
 assert.equal("pending" in actions[1],false);
});

test("repair file is not consumed while prior action identity is unresolved", () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"local-worker-repair-pending-"));
 const file=path.join(root,"repair.json");
 const worker={run_id:"LW-TEST",actions:[{request_id:"R01-01-001",action:"git_status_short",args:{},pending:true}]};
 fs.writeFileSync(file,JSON.stringify({protocol:"devexec.local-worker-repair",schema_version:1,worker_run_id:"LW-TEST",expected_action_count:1,mode:"RETRY_PLANNER"}),"utf8");
 assert.throws(()=>consumeLocalWorkerRepair(file,worker),/AMBIGUOUS_ACTION_IN_FLIGHT/);
 assert.equal(fs.existsSync(file),true);
});

test("context checkpoint retains worker and executor action identities", () => {
 const inspection=inspectLocalPlannerContext({
  run_id:"LW-TEST",
  mission:"m",
  prompt:"x".repeat(3000),
  actions:[{request_id:"R01-01-001",executor_request_id:"LW-TEST-R01-01-001",action:"read_file",args:{path:"README.md"},result:{status:"PASS",stdout:{text:"ok"}},planner_round:1}],
  working_root:"C:\\Work",
  profile:"readonly",
  round:2,
  contextWindow:1024,
 });
 assert.equal(inspection.decision,"ROTATE");
 assert.equal(inspection.checkpoint.completed_actions[0].request_id,"R01-01-001");
 assert.equal(inspection.checkpoint.completed_actions[0].executor_request_id,"LW-TEST-R01-01-001");
});
