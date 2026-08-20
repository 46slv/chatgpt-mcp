import assert from 'node:assert/strict';
import {executeHeartbeatRecoveryInvocation as e} from './devexec-heartbeat-recovery-executor.mjs';
const calls=[];const spawn=(cmd,args,opt)=>{calls.push({cmd,args,opt});return {status:0};};
let c=e({invoked:true,action:'CONTINUE_CHILD',args:['continue','R1','--target','current-chat']},{project_root:process.cwd(),spawn,stdio:'pipe'});assert.equal(c,0);assert.equal(calls[0].args.at(-3),'R1');
c=e({invoked:true,action:'RESUME_EXISTING',args:['R2']},{project_root:process.cwd(),spawn,stdio:'pipe'});assert.equal(c,0);assert.equal(calls[1].args.at(-1),'R2');
assert.equal(e({invoked:false,action:'NONE',args:[]},{spawn}),0);
assert.throws(()=>e({invoked:true,action:'BAD',args:[]},{spawn}),/unsupported heartbeat recovery/);
console.log('DEVEXEC_HEARTBEAT_AUTO_RECOVERY_EXECUTOR_V0_TEST_PASS');
