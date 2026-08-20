import assert from 'node:assert/strict';
import {buildSupervisorRehydratePrompt as b,parseFreshSupervisorResult as p,assertFreshSupervisorCandidate as a} from './devexec-supervisor-fresh-chat.mjs';
const pack={protocol:'devexec.supervisor-rehydrate-pack',schema_version:1,mission_id:'M1',fresh_notion:{ok:true},fresh_git:{head:'abc'}};
const prompt=b(pack); assert.equal(prompt.includes('Mission ID: M1'),true);
const c=p({chat_id:'new-123',response:'DEVEXEC_SUPERVISOR_REHYDRATE_ACK M1'},'M1'); assert.equal(c.chat_url,'https://chatgpt.com/c/new-123');
assert.equal(a(c,'old-123').conversation_id,'new-123');
assert.throws(()=>a(c,'new-123'),/new conversation/);
assert.throws(()=>p({chat_id:'new-123',response:'wrong'},'M1'),/acknowledgement missing/);
console.log('DEVEXEC_SUPERVISOR_FRESH_CHAT_V0_TEST_PASS');
