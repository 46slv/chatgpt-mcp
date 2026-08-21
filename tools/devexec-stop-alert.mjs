import crypto from 'node:crypto';
const TERMINAL=new Set(['NEEDS_HUMAN','CIRCUIT_BREAKER_OPEN','NON_RECOVERABLE_FAIL','HUMAN_ACTION_REQUIRED_BLOCKED']);
export function buildStopAlert(i={}){
 for(const k of ['mission_id','run_id','machine','project_root','stop_type','reason','requested_human_action'])if(typeof i[k]!=='string'||!i[k])throw new Error(k+' required');
 if(!TERMINAL.has(i.stop_type))throw new Error('stop type is not human-notifiable');
 const seed=[i.mission_id,i.run_id,i.stop_type,i.reason,i.requested_human_action].join('|');
 const dedupe=i.dedupe_key||crypto.createHash('sha256').update(seed,'utf8').digest('hex');
 return {protocol:'devexec.stop-alert',schema_version:1,mission_id:i.mission_id,run_id:i.run_id,machine:i.machine,project_root:i.project_root,stop_type:i.stop_type,reason:i.reason,last_checkpoint:i.last_checkpoint||null,requested_human_action:i.requested_human_action,git:{head:i.git?.head||null,branch:i.git?.branch||null},dedupe_key:dedupe,created_at:new Date().toISOString()};
}
export function shouldNotifyStop(i={}){
 if(i.recovered===true)return false;
 return TERMINAL.has(i.stop_type);
}
