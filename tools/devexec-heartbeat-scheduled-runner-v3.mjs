import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {resolveLatestLeafRun} from './devexec-heartbeat-scheduler.mjs';
import {buildHeartbeatRecoveryInvocation} from './devexec-heartbeat-recovery-runtime.mjs';
import {launchHeartbeatRecoveryInvocation} from './devexec-heartbeat-recovery-launcher.mjs';
function atomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.tmp-'+process.pid+'-'+Date.now();fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n','utf8');fs.renameSync(tmp,file);}
export function loadConfig(file){const c=JSON.parse(fs.readFileSync(file,'utf8'));if(c.protocol!=='devexec.heartbeat-scheduler-config'||c.schema_version!==1)throw new Error('INVALID_CONFIG');if(!c.root_run_id||!c.state_dir||!c.result_file)throw new Error('MISSING_CONFIG_FIELD');return c;}
export function runScheduledHeartbeatRecovery(c={},launcher=launchHeartbeatRecoveryInvocation){const leaf=resolveLatestLeafRun({state_dir:c.state_dir,root_run_id:c.root_run_id});const target=leaf.state.target?.target_id||c.target_alias||null;const inv=buildHeartbeatRecoveryInvocation({state:leaf.state,target_alias:target});let launched=false;let launch_code=null;if(inv.invoked){launch_code=launcher(inv,{project_root:c.project_root||process.cwd()});launched=launch_code===0;}const out={protocol:'devexec.heartbeat-scheduler-result',schema_version:3,root_run_id:c.root_run_id,leaf_run_id:leaf.state.run_id,leaf_phase:leaf.state.phase||null,status:inv.invoked?(launched?'ACTION_LAUNCHED':'ACTION_FAILED'):'SKIPPED',reason:inv.reason,action:inv.action,action_invoked:inv.invoked,launch_code,at:new Date().toISOString()};atomic(c.result_file,out);return out;}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const f=process.argv[2];if(!f)throw new Error('CONFIG_REQUIRED');process.stdout.write(JSON.stringify(runScheduledHeartbeatRecovery(loadConfig(f)),null,2)+'\n');}
