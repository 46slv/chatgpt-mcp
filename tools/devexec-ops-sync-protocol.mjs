import crypto from 'node:crypto';
const DECISIONS=new Set(['CONTINUE','STOP','NEEDS_HUMAN']);
function required(i,k){if(typeof i[k]!=='string'||!i[k])throw new Error(k+' required');}
export function buildOpsSyncPacket(i={}){
 for(const k of ['mission_id','dev_exec_run_id','machine','project_root','current_gate','status','requested_sync_reason'])required(i,k);
 const seed=[i.mission_id,i.dev_exec_run_id,i.current_gate,i.status,i.requested_sync_reason].join('|');
 const dedupe=i.dedupe_key||crypto.createHash('sha256').update(seed,'utf8').digest('hex');
 return {
 protocol:'devexec.ops-sync',schema_version:1,mission_id:i.mission_id,
 dev_exec_run_id:i.dev_exec_run_id,machine:i.machine,project_root:i.project_root,
 current_gate:i.current_gate,status:i.status,last_checkpoint:i.last_checkpoint||null,
 recent_summary:i.recent_summary||null,
 git:{head:i.git?.head||null,branch:i.git?.branch||null,status_summary:i.git?.status_summary||null},
 requested_sync_reason:i.requested_sync_reason,dedupe_key:dedupe
 };
}
export function parseOpsSyncResponse(v){
 if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('response object required');
 if(v.protocol!=='devexec.ops-sync-response'||v.schema_version!==1)throw new Error('protocol mismatch');
 required(v,'mission_id'); required(v,'notion_read_at'); required(v,'sync_id');
 if(!DECISIONS.has(v.decision))throw new Error('invalid decision');
 if(v.next_goal!==null&&typeof v.next_goal!=='string')throw new Error('invalid next_goal');
 if(!Number.isInteger(v.priority)||v.priority<0)throw new Error('invalid priority');
 if(!Array.isArray(v.constraints)||v.constraints.some(x=>typeof x!=='string'))throw new Error('invalid constraints');
 if(typeof v.notion_updated!=='boolean')throw new Error('invalid notion_updated');
 return v;
}
