import assert from 'node:assert/strict';
import {emptyRegistry,setTarget,useTarget} from './target-registry.mjs';
import {executeSupervisorRotationBoundary as e} from './devexec-supervisor-rotation-controller.mjs';
const r=emptyRegistry();setTarget(r,'current-chat','https://chatgpt.com/c/old-1');useTarget(r,'current-chat');
const client={listTools:async()=>({tools:[{name:'chatgpt_new_chat'},{name:'chatgpt_ask'}]}),callTool:async x=>({content:[{type:'text',text:JSON.stringify(x.name==='chatgpt_new_chat'?{success:true}:{chat_id:'new-2',response:'DEVEXEC_SUPERVISOR_REHYDRATE_ACK M1'})}]})};
const plan={mission_id:'M1',current_target_id:'current-chat',next_generation:2,next_alias:'supervisor-g2'};const pack={protocol:'devexec.supervisor-rehydrate-pack',mission_id:'M1'};
assert.equal((await e({plan,registry:r,client,rehydrate_pack:pack,current_conversation_id:'old-1',current_run_terminal:false})).executed,false);
const y=await e({plan,registry:r,client,rehydrate_pack:pack,current_conversation_id:'old-1',current_run_terminal:true});assert.equal(y.executed,true);assert.equal(r.default_target,'supervisor-g2');assert.equal(r.targets['current-chat'].rotation_state,'RETIRED');
console.log('DEVEXEC_SUPERVISOR_ROTATION_CONTROLLER_V0_TEST_PASS');
