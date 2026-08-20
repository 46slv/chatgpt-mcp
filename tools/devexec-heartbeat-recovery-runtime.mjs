import {planHeartbeatRecovery} from './devexec-heartbeat-recovery-plan.mjs';
export function buildHeartbeatRecoveryInvocation(input={}){
const state=input.state||{}; const plan=planHeartbeatRecovery(state);
if(plan.action==='NONE')return {invoked:false,action:'NONE',reason:plan.reason,args:[]};
if(!state.run_id)throw new Error('run_id required');
if(plan.action==='CONTINUE_CHILD'){const args=['continue',state.run_id];if(input.target_alias)args.push('--target',input.target_alias);return {invoked:true,action:plan.action,reason:plan.reason,args};}
if(plan.action==='RESUME_EXISTING'){return {invoked:true,action:plan.action,reason:plan.reason,args:[state.run_id]};}
throw new Error('unsupported heartbeat recovery action');
}
export function executeHeartbeatRecovery(input={}){
const v=buildHeartbeatRecoveryInvocation(input); if(!v.invoked)return {...v,exit_code:null};
if(typeof input.execute!=='function')throw new Error('execute callback required');
const r=input.execute(v); const code=Number.isInteger(r)?r:Number.isInteger(r?.status)?r.status:1;
return {...v,exit_code:code,success:code===0};
}
