import assert from 'node:assert/strict';
import {buildHeartbeatRecoveryInvocation as b,executeHeartbeatRecovery as e} from './devexec-heartbeat-recovery-runtime.mjs';
let x=b({state:{run_id:'R1',phase:'EXEC_IN_FLIGHT',pending:{step:2}},target_alias:'current-chat'});assert.equal(x.invoked,false);
x=b({state:{run_id:'R1',phase:'FAILED'},target_alias:'current-chat'});assert.deepEqual(x.args,['continue','R1','--target','current-chat']);
x=b({state:{run_id:'R2',phase:'SUPERVISOR_READY'}});assert.deepEqual(x.args,['R2']);assert.equal(x.action,'RESUME_EXISTING');
let seen=null;const r=e({state:{run_id:'R1',phase:'FAILED'},target_alias:'current-chat',execute:v=>{seen=v;return 0;}});assert.equal(r.success,true);assert.equal(seen.action,'CONTINUE_CHILD');
const n=e({state:{run_id:'R1',phase:'NEEDS_HUMAN'},execute:()=>{throw Error('must not run');}});assert.equal(n.invoked,false);
console.log('DEVEXEC_HEARTBEAT_AUTO_RECOVERY_RUNTIME_V0_TEST_PASS');
