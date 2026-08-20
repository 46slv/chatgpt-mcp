import fs from 'node:fs';
import {parseOpsSyncResponse} from './devexec-ops-sync-protocol.mjs';
export function buildHeartbeatSupervisorPrompt(packet){
 if(!packet||packet.protocol!=='devexec.ops-sync'||packet.current_gate!=='HEARTBEAT_V0')throw new Error('heartbeat ops sync packet required');
 return ['DEV EXEC HEARTBEAT OPS SYNC','This is an isolated heartbeat control-plane sync. Do not execute project actions from this message.','Re-read Notion authority, preserve the same mission_id, and return exactly one JSON object matching devexec.ops-sync-response schema_version 1.','OPS SYNC PACKET',JSON.stringify(packet),'END OPS SYNC PACKET'].join('\n');
}
export function parseHeartbeatSupervisorResponse(text,expectedMissionId){
 const raw=String(text||'').trim(); let value; try{value=JSON.parse(raw);}catch{const m=raw.match(/`(?:json)?\\s*([\\s\\S]*?)`/i); if(!m)throw new Error('heartbeat supervisor response is not JSON'); value=JSON.parse(m[1].trim());}
 const response=parseOpsSyncResponse(value); if(response.mission_id!==expectedMissionId)throw new Error('heartbeat mission continuity mismatch'); return response;
}
export async function sendHeartbeatOpsSync(i={}){
 if(typeof i.bridge_reply!=='function')throw new Error('bridge_reply required'); const prompt=buildHeartbeatSupervisorPrompt(i.packet);
 const raw=await i.bridge_reply(prompt); const response=parseHeartbeatSupervisorResponse(raw,i.packet.mission_id);
 if(i.response_file){fs.writeFileSync(i.response_file,JSON.stringify(response,null,2)+'\n','utf8');} return {prompt,response};
}
