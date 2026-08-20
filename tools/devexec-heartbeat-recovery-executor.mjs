import path from 'node:path';
import {spawnSync} from 'node:child_process';
export function executeHeartbeatRecoveryInvocation(v={},o={}){
if(!v.invoked||!v.action)return 0;
const root=path.resolve(o.project_root||process.cwd());
const node=o.node_path||process.execPath;
if(v.action==='CONTINUE_CHILD'){const cli=o.devexec_cli||path.join(root,'tools','devexec.mjs');const r=(o.spawn||spawnSync)(node,[cli,...v.args],{stdio:o.stdio||'inherit',env:o.env||process.env,cwd:root,windowsHide:true});return Number.isInteger(r.status)?r.status:1;}
if(v.action==='RESUME_EXISTING'){const resume=o.resume_cli||path.join(root,'tools','devexec-resume-existing.mjs');const r=(o.spawn||spawnSync)(node,[resume,...v.args],{stdio:o.stdio||'inherit',env:o.env||process.env,cwd:root,windowsHide:true});return Number.isInteger(r.status)?r.status:1;}
throw new Error('unsupported heartbeat recovery invocation: '+v.action);
}
