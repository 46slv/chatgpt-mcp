import path from 'node:path';
import {spawn} from 'node:child_process';
export function buildHeartbeatLaunch(v={},o={}){
if(!v.invoked)return null;
const root=path.resolve(o.project_root||process.cwd()); const node=o.node_path||process.execPath;
if(v.action==='CONTINUE_CHILD')return {command:node,args:[o.devexec_cli||path.join(root,'tools','devexec.mjs'),...v.args],cwd:root};
if(v.action==='RESUME_EXISTING')return {command:node,args:[o.resume_cli||path.join(root,'tools','devexec-resume-existing.mjs'),...v.args],cwd:root};
throw new Error('unsupported heartbeat launch action: '+v.action);
}
export function launchHeartbeatRecoveryInvocation(v={},o={}){
const spec=buildHeartbeatLaunch(v,o); if(!spec)return 0;
const launch=o.spawn||spawn; const child=launch(spec.command,spec.args,{cwd:spec.cwd,env:o.env||process.env,detached:true,stdio:'ignore',windowsHide:true});
if(!child||typeof child.unref!=='function')throw new Error('heartbeat recovery launch failed'); child.unref(); return 0;
}
