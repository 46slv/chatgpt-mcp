import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {resolveLatestLeafRun,classifyHeartbeatLeaf} from './devexec-heartbeat-scheduler.mjs';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'devexec-hb-leaf-'));
const write=(id,parent,phase,createdAt,extra={})=>{
  fs.writeFileSync(path.join(dir,id+'.json'),JSON.stringify({run_id:id,parent_run_id:parent,phase,created_at:createdAt,...extra},null,2)+'\n','utf8');
};
write('root',null,'FAILED','2026-01-01T00:00:00Z');
write('child-a','root','FAILED','2026-01-02T00:00:00Z');
write('child-b','child-a','FAILED','2026-01-03T00:00:00Z',{rounds:{'7':{send_state:'FAILED_PRE_SUBMIT'}}});
assert.equal(resolveLatestLeafRun({state_dir:dir,root_run_id:'root'}).state.run_id,'child-b');
assert.deepEqual(classifyHeartbeatLeaf({phase:'EXEC_IN_FLIGHT',pending:{step:1}}),{safe:false,reason:'EXEC_IN_FLIGHT'});
assert.deepEqual(classifyHeartbeatLeaf({phase:'FAILED',rounds:{'2':{send_state:'IN_FLIGHT'}}}),{safe:false,reason:'SUPERVISOR_IN_FLIGHT'});
assert.deepEqual(classifyHeartbeatLeaf({phase:'NEEDS_HUMAN'}),{safe:false,reason:'NEEDS_HUMAN'});
assert.deepEqual(classifyHeartbeatLeaf({phase:'FAILED',stop_type:'CIRCUIT_BREAKER_OPEN'}),{safe:false,reason:'CIRCUIT_BREAKER_OPEN'});
assert.deepEqual(classifyHeartbeatLeaf({phase:'COMPLETE'}),{safe:false,reason:'COMPLETE'});
assert.deepEqual(classifyHeartbeatLeaf({phase:'CANCELLED'}),{safe:false,reason:'CANCELLED'});
assert.deepEqual(classifyHeartbeatLeaf({phase:'FAILED',rounds:{'2':{send_state:'FAILED_PRE_SUBMIT'}}}),{safe:true,reason:'SAFE'});
fs.rmSync(dir,{recursive:true,force:true});
console.log('DEVEXEC_HEARTBEAT_LEAF_RESOLVER_AND_TERMINAL_GUARD_V0_TEST_PASS');
