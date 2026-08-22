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
 const pending=actions.find(x=>x?.pending===true)||null;
 const completed=actions.filter(x=>x?.pending!==true&&x?.result);
 return {protocol:"dev-exec.mission-escalation",schema_version:1,mission_id:worker.run_id,decision:"NEEDS_SUPERVISOR",reason:pending?"LOCAL_WORKER_AMBIGUOUS_ACTION_IN_FLIGHT":"LOCAL_WORKER_"+worker.status,step_count:actions.length,failure_count:worker.status==="FAILED"?1:0,completed_actions:completed.map((x,i)=>x.executor_request_id||x.request_id||x.result?.request_id||worker.run_id+"-"+String(i+1)),evidence_keys:[...new Set(completed.map(x=>x.action).filter(Boolean))],remaining_criteria:pending?["reconcile_ambiguous_action:"+String(pending.request_id||pending.action||"unknown"),"local_worker_completion"]:["local_worker_completion"],requested_help:pending?"RECONCILE_AMBIGUOUS_LOCAL_ACTION_BEFORE_REPAIR":"REPAIR_LOCAL_WORKER_OR_SUPPLY_NEXT_TYPED_ACTIONS"};
}
export function writeLocalWorkerEscalation(worker,file=null){const escalation=buildLocalWorkerEscalation(worker);const target=file||defaultLocalWorkerEscalationFile();writeMissionEscalation(target,escalation);return {file:target,escalation};}
