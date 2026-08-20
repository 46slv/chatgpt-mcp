import { estimateContextTokens } from './devexec-context-governor.mjs';
export function inspectSupervisorContext(o={}){
const x=estimateContextTokens(o.contextText||'');
const w=o.contextWindow||128000; const u=x/w;
if(o.ambiguousInFlight)return {decision:'CONTINUE',reason:'AMBIGUOUS_IN_FLIGHT_ROTATION_FORBIDDEN',rotation_allowed:false};
if(o.authorityStale)return {decision:'CHECKPOINT',reason:'AUTHORITY_REFRESH_REQUIRED',rotation_allowed:false,estimated_tokens:x,utilization:u};
if(u>=(o.hardRatio||0.78))return {decision:'ROTATE',reason:'HARD_CONTEXT_THRESHOLD',rotation_allowed:true,estimated_tokens:x,utilization:u};
if((o.repeatedFailures||0)>=3)return {decision:'ROTATE',reason:'REPEATED_SUPERVISOR_FAILURES',rotation_allowed:true,estimated_tokens:x,utilization:u};
if(o.majorCheckpoint)return {decision:'CHECKPOINT',reason:'MAJOR_CHECKPOINT',rotation_allowed:true,estimated_tokens:x,utilization:u};
if(u>=(o.softRatio||0.65))return {decision:'CHECKPOINT',reason:'SOFT_CONTEXT_THRESHOLD',rotation_allowed:true,estimated_tokens:x,utilization:u};
return {decision:'CONTINUE',reason:'CONTEXT_WITHIN_BUDGET',rotation_allowed:true,estimated_tokens:x,utilization:u};
}
export function buildSupervisorCheckpoint(i={}){
if(!i.mission_id||!i.run_id)throw new Error('mission_id and run_id required');
return {protocol:'devexec.supervisor-checkpoint',schema_version:1,mission_id:i.mission_id,run_id:i.run_id,target:i.target||null,notion_authority:i.notion_authority||null,git:i.git||null,completed_evidence:i.completed_evidence||[],next_goal:i.next_goal||null,constraints:i.constraints||[]};
}
export function buildSupervisorRehydratePack(i={}){
if(!i.checkpoint||i.checkpoint.protocol!=='devexec.supervisor-checkpoint')throw new Error('valid checkpoint required');
if(!i.freshNotion||!i.freshGit)throw new Error('fresh authority required');
return {protocol:'devexec.supervisor-rehydrate-pack',schema_version:1,mission_id:i.checkpoint.mission_id,checkpoint:i.checkpoint,fresh_notion:i.freshNotion,fresh_git:i.freshGit,latest_ops_sync:i.latestOpsSync||null};
}
