import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {inspectLocalAgentGoalCompletion} from "./devexec-local-agent-goal-state.mjs";
import {enqueueMissionAmendment, openMissionControl} from "./devexec-mission-control.mjs";
import {buildMissionChildLaunchSpec, readMissionLaunchState} from "./devexec-mission-launch.mjs";

function setup({decision="COMPLETE",status="DONE",targetAlias=undefined}={}) {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),"devexec-local-agent-mission-"));
  const runId="RUN-ROOT";
  const missionId="MISSION-LOCAL";
  const agentRunId="AGENT-1";
  const workerRunId="WORKER-1";
  const runDir=path.join(base,"ChatGPTMCPProbe","dev-exec-runs",runId);
  const agentDir=path.join(base,"ChatGPTMCPProbe","local-agent-runs");
  fs.mkdirSync(runDir,{recursive:true});
  fs.mkdirSync(agentDir,{recursive:true});
  const owner={
    protocol:"devexec.local-agent-owner",
    schema_version:1,
    dev_exec_run_id:runId,
    mission_id:missionId,
    parent_run_id:null,
    agent_run_id:agentRunId,
    worker_run_id:workerRunId,
    goal:"initial goal",
  };
  if(targetAlias!==undefined) owner.target_alias=targetAlias;
  fs.writeFileSync(path.join(runDir,"local-agent-owner.json"),JSON.stringify(owner,null,2)+"\n");
  fs.writeFileSync(path.join(agentDir,agentRunId+".json"),JSON.stringify({
    protocol:"devexec.local-agent",
    run_id:agentRunId,
    worker_run_id:workerRunId,
    status,
    decision,
  },null,2)+"\n");
  return {base,runDir,runId,missionId};
}

test("after_current_goal is durable and dispatched before COMPLETE is returned", () => {
  const ctx=setup();
  const control=openMissionControl({base:ctx.base,mission_id:ctx.missionId,run_id:ctx.runId});
  enqueueMissionAmendment(control,{
    amendment_id:"AMEND-AFTER",
    idempotency_key:"after-1",
    kind:"MISSION_AMENDMENT",
    apply_mode:"after_current_goal",
    payload:{add_work:"continue with the verification goal"},
  });
  const dispatches=[];
  const result=inspectLocalAgentGoalCompletion(ctx,{
    dispatch_continuation: input => {
      dispatches.push(input);
      return {status:"LAUNCHED",child_run_id:"CHILD-TEST"};
    },
  });
  assert.equal(result.complete,true);
  assert.equal(result.mission_boundary.applied.length,1);
  assert.equal(result.mission_boundary.objective.queued_work[0].text,"continue with the verification goal");
  assert.equal(result.mission_boundary.continuation.status,"PENDING");
  assert.equal(dispatches.length,1);
  assert.equal(dispatches[0].mission_id,ctx.missionId);
  assert.equal(dispatches[0].parent_run_id,ctx.runId);
  assert.equal(dispatches[0].launch_id,result.mission_boundary.continuation.launch_id);
  assert.equal(result.mission_continuation_dispatch.status,"LAUNCHED");

  const launchState=readMissionLaunchState(openMissionControl({base:ctx.base,mission_id:ctx.missionId,run_id:ctx.runId}));
  assert.equal(launchState.launches.length,1);
  assert.equal(launchState.launches[0].goal,"continue with the verification goal");
});

test("supervised completion preserves explicit target alias into child launch environment", () => {
  const ctx=setup({targetAlias:"devexec-supervisor"});
  const control=openMissionControl({base:ctx.base,mission_id:ctx.missionId,run_id:ctx.runId});
  enqueueMissionAmendment(control,{
    amendment_id:"AMEND-TARGET",
    idempotency_key:"target-1",
    kind:"MISSION_AMENDMENT",
    apply_mode:"after_current_goal",
    payload:{add_work:"continue on the same supervisor target"},
  });

  const result=inspectLocalAgentGoalCompletion(ctx,{
    dispatch_continuation:()=>({status:"LAUNCHED",child_run_id:"CHILD-TARGET"}),
  });
  assert.equal(result.complete,true);
  const reopened=openMissionControl({base:ctx.base,mission_id:ctx.missionId,run_id:ctx.runId});
  const launch=readMissionLaunchState(reopened).launches[0];
  assert.equal(launch.target_alias,"devexec-supervisor");
  const spec=buildMissionChildLaunchSpec(reopened,launch,{
    entry_path:"/tmp/devexec-goal.mjs",
    node_path:process.execPath,
  });
  assert.equal(spec.env.DEV_EXEC_TARGET_ALIAS,"devexec-supervisor");
});

test("legacy supervised owner without target alias remains valid", () => {
  const ctx=setup();
  const control=openMissionControl({base:ctx.base,mission_id:ctx.missionId,run_id:ctx.runId});
  enqueueMissionAmendment(control,{
    amendment_id:"AMEND-LEGACY",
    idempotency_key:"legacy-1",
    kind:"MISSION_AMENDMENT",
    apply_mode:"after_current_goal",
    payload:{add_work:"legacy continuation"},
  });
  const result=inspectLocalAgentGoalCompletion(ctx,{
    dispatch_continuation:()=>({status:"LAUNCHED",child_run_id:"CHILD-LEGACY"}),
  });
  assert.equal(result.complete,true);
  const launch=readMissionLaunchState(openMissionControl({base:ctx.base,mission_id:ctx.missionId,run_id:ctx.runId})).launches[0];
  assert.equal(launch.target_alias,null);
});

test("malformed persisted target alias fails closed before continuation mutation", () => {
  const ctx=setup({targetAlias:"   "});
  const control=openMissionControl({base:ctx.base,mission_id:ctx.missionId,run_id:ctx.runId});
  enqueueMissionAmendment(control,{
    amendment_id:"AMEND-BAD-TARGET",
    idempotency_key:"bad-target-1",
    kind:"MISSION_AMENDMENT",
    apply_mode:"after_current_goal",
    payload:{add_work:"must not launch"},
  });
  assert.throws(()=>inspectLocalAgentGoalCompletion(ctx),/Invalid local-agent-owner target_alias/);
  assert.equal(readMissionLaunchState(control).launches.length,0);
});

test("dispatch failure aborts inspection before terminal COMPLETE can be returned", () => {
  const ctx=setup();
  const control=openMissionControl({base:ctx.base,mission_id:ctx.missionId,run_id:ctx.runId});
  enqueueMissionAmendment(control,{
    amendment_id:"AMEND-DISPATCH-FAIL",
    idempotency_key:"dispatch-fail-1",
    kind:"MISSION_AMENDMENT",
    apply_mode:"after_current_goal",
    payload:{add_work:"must not be lost"},
  });
  assert.throws(
    ()=>inspectLocalAgentGoalCompletion(ctx,{dispatch_continuation:()=>{throw new Error("synthetic dispatch failure");}}),
    /synthetic dispatch failure/,
  );
  const reopened=openMissionControl({base:ctx.base,mission_id:ctx.missionId,run_id:ctx.runId});
  assert.equal(reopened.amendments.amendments[0].status,"APPLIED");
  const launchState=readMissionLaunchState(reopened);
  assert.equal(launchState.launches.length,1);
  assert.equal(launchState.launches[0].status,"PENDING");
});

test("after_current_goal stays pending while local goal is not complete", () => {
  const ctx=setup({decision:"NEEDS_SUPERVISOR",status:"RUNNING"});
  const control=openMissionControl({base:ctx.base,mission_id:ctx.missionId,run_id:ctx.runId});
  enqueueMissionAmendment(control,{
    amendment_id:"AMEND-LATER",
    idempotency_key:"later-1",
    kind:"MISSION_AMENDMENT",
    apply_mode:"after_current_goal",
    payload:{add_work:"later work"},
  });
  let dispatched=false;
  const result=inspectLocalAgentGoalCompletion(ctx,{dispatch_continuation:()=>{dispatched=true;}});
  assert.equal(result.complete,false);
  assert.equal(result.mission_boundary.applied.length,0);
  assert.equal(result.mission_boundary.continuation,null);
  assert.equal(dispatched,false);
  const reopened=openMissionControl({base:ctx.base,mission_id:ctx.missionId,run_id:ctx.runId});
  assert.equal(reopened.amendments.amendments[0].status,"PENDING");
});
