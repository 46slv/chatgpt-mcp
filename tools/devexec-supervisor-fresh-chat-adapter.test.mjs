import assert from 'node:assert/strict';
import {createFreshSupervisorWithClient as c} from './devexec-supervisor-fresh-chat-adapter.mjs';
const calls=[]; const client={async listTools(){return {tools:[{name:'chatgpt_new_chat'},{name:'chatgpt_ask'}]};},async callTool(x){calls.push(x);if(x.name==='chatgpt_new_chat')return {content:[{type:'text',text:JSON.stringify({success:true,message:'ok'})}]};return {content:[{type:'text',text:JSON.stringify({chat_id:'fresh-222',response:'DEVEXEC_SUPERVISOR_REHYDRATE_ACK M1'})}]};}};
const pack={protocol:'devexec.supervisor-rehydrate-pack',schema_version:1,mission_id:'M1',fresh_notion:{ok:true},fresh_git:{head:'abc'}};
const r=await c(client,{rehydrate_pack:pack,current_conversation_id:'old-111'}); assert.equal(r.conversation_id,'fresh-222'); assert.equal(calls.length,2); assert.equal(calls[0].name,'chatgpt_new_chat'); assert.equal(calls[1].name,'chatgpt_ask'); assert.equal(calls[1].arguments.prompt.includes('Mission ID: M1'),true);
await assert.rejects(()=>c({listTools:async()=>({tools:[{name:'chatgpt_ask'}]}),callTool:async()=>({})},{rehydrate_pack:pack,current_conversation_id:'old-111'}),/chatgpt_new_chat unavailable/);
console.log('DEVEXEC_SUPERVISOR_FRESH_CHAT_ADAPTER_V0_TEST_PASS');
