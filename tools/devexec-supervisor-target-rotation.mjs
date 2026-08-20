import {setTarget,useTarget} from './target-registry.mjs';
export function stageSupervisorTarget(registry,input={}){
if(!input.mission_id||!Number.isInteger(input.generation)||input.generation<1||!input.chat_url)throw new Error('invalid supervisor target rotation input');
const alias=input.alias||('supervisor-g'+input.generation);
if(registry.targets[alias])throw new Error('target generation already exists');
const target=setTarget(registry,alias,input.chat_url,{mission_id:input.mission_id,supervisor_generation:input.generation,previous_target_id:input.previous_target_id||null,rotation_state:'CANDIDATE',created_at:input.created_at||new Date().toISOString()});
return {alias,target};
}
export function promoteSupervisorTarget(registry,input={}){
const target=registry.targets[input.alias];
if(!target)throw new Error('candidate target not found');
if(target.rotation_state!=='CANDIDATE')throw new Error('target is not candidate');
if(target.mission_id!==input.mission_id)throw new Error('mission continuity mismatch');
if(input.verified!==true||input.rehydrate_ack!==true)throw new Error('candidate verification incomplete');
target.rotation_state='ACTIVE'; target.activated_at=input.activated_at||new Date().toISOString();
useTarget(registry,input.alias);
return target;
}
export function retireSupervisorTarget(registry,input={}){
const target=registry.targets[input.alias]; if(!target)throw new Error('target not found');
if(registry.default_target===input.alias)throw new Error('cannot retire active default target');
target.rotation_state='RETIRED'; target.retired_at=input.retired_at||new Date().toISOString(); return target;
}
