import fs from "node:fs";
import path from "node:path";
export function inspectLocalAgentGoalCompletion({runDir,base,runId}){
 const ownerFile=path.join(runDir,"local-agent-owner.json");
 if(!fs.existsSync(ownerFile))return null;
 const owner=JSON.parse(fs.readFileSync(ownerFile,"utf8"));
 if(owner.protocol!=="devexec.local-agent-owner"||owner.schema_version!==1||owner.dev_exec_run_id!==runId||!owner.agent_run_id||!owner.worker_run_id)throw new Error("Invalid local-agent-owner.json");
 const agentFile=path.join(base,"ChatGPTMCPProbe","local-agent-runs",owner.agent_run_id+".json");
 if(!fs.existsSync(agentFile))return {owner,complete:false,reason:"AGENT_STATE_MISSING"};
 const agent=JSON.parse(fs.readFileSync(agentFile,"utf8"));
 if(agent.protocol!=="devexec.local-agent"||agent.run_id!==owner.agent_run_id||agent.worker_run_id!==owner.worker_run_id)throw new Error("Local Agent owner/state mismatch");
 const complete=agent.status==="DONE"&&agent.decision==="COMPLETE";
 return {owner,agent,complete,reason:complete?"LOCAL_AGENT_COMPLETE":"LOCAL_AGENT_NOT_COMPLETE"};
}
