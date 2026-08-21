import os from "node:os";
import path from "node:path";
import {writeMissionEscalation} from "./mission-supervisor-io.mjs";
export function defaultLocalWorkerEscalationFile(runId=process.env.DEV_EXEC_RUN_ID){
 if(!runId||!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error("valid DEV_EXEC_RUN_ID required");
 const base=process.env.LOCALAPPDATA||path.join(os.homedir(),"AppData","Local");
 return path.join(base,"ChatGPTMCPProbe","dev-exec-runs",runId,"mission-escalation.json");
}
export function buildLocalWorkerEscalation(worker){
 if(!worker||!['FAILED','BLOCKED'].includes(worker.status)) throw new Error("worker must require supervisor");
 const actions=Array.isArray(worker.actions)?worker.actions:[];
 return {protocol:"dev-exec.mission-escalation",schema_version:1,mission_id:worker.run_id,decision:"NEEDS_SUPERVISOR",reason:"LOCAL_WORKER_"+worker.status,step_count:actions.length,failure_count:worker.status==="FAILED"?1:0,completed_actions:actions.map((x,i)=>x.result?.request_id||worker.run_id+"-"+String(i+1)),evidence_keys:[...new Set(actions.map(x=>x.action).filter(Boolean))],remaining_criteria:["local_worker_completion"],requested_help:"REPAIR_LOCAL_WORKER_OR_SUPPLY_NEXT_TYPED_ACTIONS"};
}
export function writeLocalWorkerEscalation(worker,file=null){const escalation=buildLocalWorkerEscalation(worker);const target=file||defaultLocalWorkerEscalationFile();writeMissionEscalation(target,escalation);return {file:target,escalation};}
