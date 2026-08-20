export function buildSupervisorRehydratePrompt(pack={}){
if(!pack||pack.protocol!=='devexec.supervisor-rehydrate-pack'||!pack.mission_id)throw new Error('valid rehydrate pack required');
return ['DEV EXEC SUPERVISOR REHYDRATE','Mission ID: '+pack.mission_id,'This is a replacement Supervisor conversation for the same durable mission.','Fresh Notion and Git authority override old conversation history.','Do not create a new mission. Preserve mission_id exactly.','Rehydrate pack:',JSON.stringify(pack,null,2),'Reply with exactly: DEVEXEC_SUPERVISOR_REHYDRATE_ACK '+pack.mission_id].join('\n');
}
export function parseFreshSupervisorResult(result={},missionId){
if(!missionId)throw new Error('mission id required');
if(result.error)throw new Error('fresh supervisor request failed: '+result.error);
if(!result.chat_id||!/^[A-Za-z0-9-]+$/.test(result.chat_id))throw new Error('fresh supervisor chat_id missing');
const expected='DEVEXEC_SUPERVISOR_REHYDRATE_ACK '+missionId;
if(typeof result.response!=='string'||!result.response.includes(expected))throw new Error('rehydrate acknowledgement missing');
return {mission_id:missionId,conversation_id:result.chat_id,chat_url:'https://chatgpt.com/c/'+result.chat_id,rehydrate_ack:true};
}
export function assertFreshSupervisorCandidate(candidate,currentConversationId){
if(!candidate?.rehydrate_ack||!candidate.conversation_id)throw new Error('invalid fresh supervisor candidate');
if(candidate.conversation_id===currentConversationId)throw new Error('fresh supervisor must use a new conversation');
return candidate;
}
