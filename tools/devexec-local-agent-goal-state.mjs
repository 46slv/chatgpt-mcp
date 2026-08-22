import fs from "node:fs";
import path from "node:path";

import {dispatchMissionContinuationSync} from "./devexec-mission-continuation-dispatch.mjs";
import {applyMissionLoopBoundary} from "./devexec-mission-loop-boundary.mjs";
import {normalizeMissionConstraints} from "./devexec-mission-constraint-envelope.mjs";

function readOptionalTargetAlias(owner){
 if(owner.target_alias==null)return null;
 if(typeof owner.target_alias!=="string"||!owner.target_alias.trim())throw new Error("Invalid local-agent-owner target_alias");
 return owner.target_alias.trim();
}

function readOptionalMissionConstraints(owner){
 try{return normalizeMissionConstraints(owner.mission_constraints??[]);}
 catch(error){const wrapped=new Error("Invalid local-agent-owner mission_constraints");wrapped.cause=error;throw wrapped;}
}

export function inspectLocalAgentGoalCompletion({runDir,base,runId},{dispatch_continuation=dispatchMissionContinuationSync}={}){
 const ownerFile=path.join(runDir,"local-agent-owner.json");
 if(!fs.existsSync(ownerFile))return null;
 const owner=JSON.parse(fs.readFileSync(ownerFile,"utf8"));
 if(owner.protocol!=="devexec.local-agent-owner"||owner.schema_version!==1||owner.dev_exec_run_id!==runId||!owner.agent_run_id||!owner.worker_run_id)throw new Error("Invalid local-agent-owner.json");
 const targetAlias=readOptionalTargetAlias(owner);
 const missionConstraints=readOptionalMissionConstraints(owner);
 const agentFile=path.join(base,"ChatGPTMCPProbe","local-agent-runs",owner.agent_run_id+".json");
 if(!fs.existsSync(agentFile))return {owner,complete:false,reason:"AGENT_STATE_MISSING",mission_constraints:missionConstraints,mission_boundary:null,mission_continuation_dispatch:null};
 const agent=JSON.parse(fs.readFileSync(agentFile,"utf8"));
 if(agent.protocol!=="devexec.local-agent"||agent.run_id!==owner.agent_run_id||agent.worker_run_id!==owner.worker_run_id)throw new Error("Local Agent owner/state mismatch");
 const complete=agent.status==="DONE"&&agent.decision==="COMPLETE";
 const missionBoundary=owner.mission_id?applyMissionLoopBoundary({
  base,
  mission_id:owner.mission_id,
  run_id:runId,
  parent_run_id:owner.parent_run_id??null,
  current_goal_complete:complete,
  pending_action:false,
  ambiguous_action:false,
  target_alias:targetAlias,
 }):null;
 const continuationDispatch=complete&&missionBoundary?.continuation?dispatch_continuation({
  base,
  mission_id:owner.mission_id,
  parent_run_id:runId,
  launch_id:missionBoundary.continuation.launch_id,
 }):null;
 return {owner,agent,complete,reason:complete?"LOCAL_AGENT_COMPLETE":"LOCAL_AGENT_NOT_COMPLETE",mission_constraints:missionConstraints,mission_boundary:missionBoundary,mission_continuation_dispatch:continuationDispatch};
}
