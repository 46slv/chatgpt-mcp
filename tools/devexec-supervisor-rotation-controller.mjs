import {stageSupervisorTarget,promoteSupervisorTarget,retireSupervisorTarget} from './devexec-supervisor-target-rotation.mjs';
import {createFreshSupervisorWithClient} from './devexec-supervisor-fresh-chat-adapter.mjs';
export async function executeSupervisorRotationBoundary(x={}){
if(!x.plan||!x.registry||!x.client||!x.rehydrate_pack)throw Error('rotation input incomplete');
if(!x.current_run_terminal)return {executed:false,reason:'CURRENT_RUN_NOT_TERMINAL'};
if(x.pending_execution)return {executed:false,reason:'PENDING_EXECUTION'};
const p=x.plan; const c=await createFreshSupervisorWithClient(x.client,{rehydrate_pack:x.rehydrate_pack,current_conversation_id:x.current_conversation_id});
const s=stageSupervisorTarget(x.registry,{mission_id:p.mission_id,generation:p.next_generation,alias:p.next_alias,chat_url:c.chat_url,previous_target_id:p.current_target_id});
promoteSupervisorTarget(x.registry,{alias:s.alias,mission_id:p.mission_id,verified:true,rehydrate_ack:c.rehydrate_ack});
if(p.current_target_id!==s.alias&&x.registry.targets[p.current_target_id])retireSupervisorTarget(x.registry,{alias:p.current_target_id});
if(x.save_registry)x.save_registry(x.registry);
return {executed:true,reason:'ROTATION_COMPLETE',mission_id:p.mission_id,target_id:s.alias,conversation_id:c.conversation_id};
}
