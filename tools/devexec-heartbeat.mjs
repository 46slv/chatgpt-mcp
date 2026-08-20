import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {buildOpsSyncPacket} from './devexec-ops-sync-protocol.mjs';
export function inspectHeartbeatSafety(state={}){
 if(state.pending)return {safe:false,reason:'EXEC_IN_FLIGHT'};
 if(String(state.phase||'').includes('IN_FLIGHT'))return {safe:false,reason:'PHASE_IN_FLIGHT'};
 if(Object.values(state.rounds||{}).some(x=>x&&x.send_state==='IN_FLIGHT'))return {safe:false,reason:'SUPERVISOR_IN_FLIGHT'};
 return {safe:true,reason:'SAFE'};
}
function git(root,args){try{return execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{return null;}}
export function buildHeartbeatPacket(i={}){
 if(!i.mission_id||!i.dev_exec_run_id||!i.machine||!i.project_root)throw new Error('heartbeat identity required');
 const slot=String(i.slot||Math.floor(Date.now()/60000));
 const dedupe=crypto.createHash('sha256').update([i.mission_id,i.dev_exec_run_id,'HEARTBEAT',slot].join('|'),'utf8').digest('hex');
 return buildOpsSyncPacket({mission_id:i.mission_id,dev_exec_run_id:i.dev_exec_run_id,machine:i.machine,project_root:i.project_root,current_gate:'HEARTBEAT_V0',status:String(i.state?.phase||'UNKNOWN'),last_checkpoint:{step:i.state?.step??null,marker:'DEVEXEC_HEARTBEAT_TICK'},recent_summary:'Scheduled Dev Exec heartbeat OPS_SYNC.',git:{head:git(i.project_root,['rev-parse','HEAD']),branch:git(i.project_root,['branch','--show-current']),status_summary:git(i.project_root,['status','--short'])},requested_sync_reason:'HEARTBEAT',dedupe_key:dedupe});
}
export function persistHeartbeatResult(file,value){
 fs.mkdirSync(path.dirname(file),{recursive:true}); const temp=file+'.tmp-'+process.pid+'-'+Date.now();
 fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n','utf8'); fs.renameSync(temp,file); return file;
}
