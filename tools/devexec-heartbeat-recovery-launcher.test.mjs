import assert from 'node:assert/strict';
import {buildHeartbeatLaunch as b,launchHeartbeatRecoveryInvocation as l} from './devexec-heartbeat-recovery-launcher.mjs';
const n=b({invoked:false,action:'NONE',args:[]},{project_root:process.cwd()});assert.equal(n,null);
const c=b({invoked:true,action:'CONTINUE_CHILD',args:['continue','R1','--target','current-chat']},{project_root:process.cwd()});assert.equal(c.args.includes('continue'),true);assert.equal(c.args.includes('R1'),true);
const r=b({invoked:true,action:'RESUME_EXISTING',args:['R2']},{project_root:process.cwd()});assert.equal(r.args.at(-1),'R2');
let seen=null,unref=false;const fake=(command,args,options)=>{seen={command,args,options};return {unref(){unref=true;}};};
assert.equal(l({invoked:true,action:'CONTINUE_CHILD',args:['continue','R1']},{project_root:process.cwd(),spawn:fake}),0);assert.equal(seen.options.detached,true);assert.equal(seen.options.stdio,'ignore');assert.equal(unref,true);
assert.throws(()=>b({invoked:true,action:'BAD',args:[]},{project_root:process.cwd()}),/unsupported heartbeat launch/);
console.log('DEVEXEC_HEARTBEAT_DETACHED_RECOVERY_LAUNCHER_V0_TEST_PASS');
