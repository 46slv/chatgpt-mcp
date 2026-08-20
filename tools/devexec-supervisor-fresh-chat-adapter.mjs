import {buildSupervisorRehydratePrompt,parseFreshSupervisorResult,assertFreshSupervisorCandidate} from './devexec-supervisor-fresh-chat.mjs';
function textJson(result,label){if(result?.isError)throw new Error(label+' MCP error');const blocks=(result?.content||[]).filter(x=>x.type==='text').map(x=>x.text);if(blocks.length!==1)throw new Error(label+' expected one text block');return JSON.parse(blocks[0]);}
export async function createFreshSupervisorWithClient(client,input={}){
if(!client||typeof client.listTools!=='function'||typeof client.callTool!=='function')throw new Error('MCP client required');
if(!input.rehydrate_pack||!input.current_conversation_id)throw new Error('rehydrate pack and current conversation required');
const listed=await client.listTools(); const names=new Set((listed.tools||[]).map(x=>x.name));
for(const n of ['chatgpt_new_chat','chatgpt_ask'])if(!names.has(n))throw new Error(n+' unavailable');
const fresh=textJson(await client.callTool({name:'chatgpt_new_chat',arguments:{}}),'chatgpt_new_chat');
if(fresh.success!==true)throw new Error('new chat failed: '+String(fresh.message||''));
const prompt=buildSupervisorRehydratePrompt(input.rehydrate_pack);
const asked=textJson(await client.callTool({name:'chatgpt_ask',arguments:{prompt,timeout_minutes:input.timeout_minutes||30}}),'chatgpt_ask');
const candidate=parseFreshSupervisorResult(asked,input.rehydrate_pack.mission_id);
return assertFreshSupervisorCandidate(candidate,input.current_conversation_id);
}
