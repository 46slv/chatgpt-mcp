export function buildSupervisorRotationPlan(i={}){
if(!i.mission_id||!i.run_id||!i.current_target_id||!Number.isInteger(i.next_generation)||i.next_generation<1)throw new Error('invalid supervisor rotation plan');
if(i.ambiguous_in_flight===true)throw new Error('rotation forbidden during ambiguous in-flight execution');
return {protocol:'devexec.supervisor-rotation-plan',schema_version:1,mission_id:i.mission_id,run_id:i.run_id,current_target_id:i.current_target_id,next_generation:i.next_generation,next_alias:i.next_alias||('supervisor-g'+i.next_generation),state:'WAIT_RUN_BOUNDARY',requires:['terminal-or-safe-checkpoint-boundary','fresh-new-chat','capture-and-verify-candidate-target','rehydrate-ack','promote-candidate','retire-old-target'],checkpoint_file:i.checkpoint_file||null,created_at:i.created_at||new Date().toISOString()};
}
export function canActivateSupervisorRotation(i={}){
if(!i.plan||i.plan.protocol!=='devexec.supervisor-rotation-plan')throw new Error('valid rotation plan required');
if(i.current_run_terminal!==true)return {allowed:false,reason:'CURRENT_RUN_NOT_TERMINAL'};
if(i.pending_execution===true)return {allowed:false,reason:'PENDING_EXECUTION'};
if(i.candidate_verified!==true)return {allowed:false,reason:'CANDIDATE_NOT_VERIFIED'};
if(i.rehydrate_ack!==true)return {allowed:false,reason:'REHYDRATE_NOT_ACKNOWLEDGED'};
return {allowed:true,reason:'SAFE_TO_PROMOTE'};
}
