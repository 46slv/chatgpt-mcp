import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {inspectLocalAgentGoalCompletion} from "./devexec-local-agent-goal-state.mjs";
import {enqueueMissionAmendment, openMissionControl} from "./devexec-mission-control.mjs";
import {readMissionLaunchState} from "./devexec-mission-launch.mjs";

function setup({decision="COMPLETE",status="DONE"}={}) {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),"devexec-local-agent-mission-"));
  const runId="RUN-ROOT";
  const missionId="MISSION-LOCAL";
  const agentRunId="AGENT-1";
  const workerRunId="WORKER-1";
  const runDir=path.join(base,"ChatGPTMCPProbe","dev-exec-runs",runId);
  const agentDir=path.join(base,"ChatGPTMCPProbe","local-agent-runs");
  fs.mkdirSync(runDir,{recursive:true});
  fs.mkdirSync(agentDir,{recursive:true});
  fs.writeFileSync(path.join(runDir,"local-agent-owner.json"),JSON.stringify({
    protocol:"devexec.local-agent-owner",
    schema_version:1,
    dev_exec_run_id:runId,
    mission_id:missionId,
    parent_run_id:null,
    agent_run_id:agentRunId,
    worker_run_id:workerRunId,
    goal:"initial goal",
  },null,2)+"\n");
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
