import fs from 'node:fs';
import path from 'node:path';
import {resolveLatestLeafRun} from './devexec-heartbeat-scheduler.mjs';
import {executeHeartbeatRecovery} from './devexec-heartbeat-recovery-runtime.mjs';
function atomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.tmp-'+process.pid+'-'+Date.now();fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n','utf8');fs.renameSync(tmp,file);}
export function runScheduledHeartbeatRecovery(c={},execute=null){
if(!c.root_run_id||!c.state_dir||!c.result_file)throw new Error('heartbeat scheduler config incomplete');
const leaf=resolveLatestLeafRun({state_dir:c.state_dir,root_run_id:c.root_run_id});
const target=leaf.state.target?.target_id||c.target_alias||null;
const r=executeHeartbeatRecovery({state:leaf.state,target_alias:target,execute:execute||(()=>{throw new Error('EXECUTOR_NOT_CONFIGURED');})});
const out={protocol:'devexec.heartbeat-scheduler-result',schema_version:2,root_run_id:c.root_run_id,leaf_run_id:leaf.state.run_id,leaf_phase:leaf.state.phase||null,status:r.invoked?(r.success?'ACTION_SUCCEEDED':'ACTION_FAILED'):'SKIPPED',reason:r.reason,action:r.action,action_invoked:r.invoked,exit_code:r.exit_code??null,at:new Date().toISOString()};
atomic(c.result_file,out);return out;
}
