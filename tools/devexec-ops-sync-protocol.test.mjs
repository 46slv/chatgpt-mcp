import assert from 'node:assert/strict';
import {buildOpsSyncPacket,parseOpsSyncResponse} from './devexec-ops-sync-protocol.mjs';
const p=buildOpsSyncPacket({
 mission_id:'M1',dev_exec_run_id:'R1',machine:'SHIRO-WS',
 project_root:'D:/Documents/ChatGPTMCPProbe',current_gate:'OPS_SYNC_V0',
 status:'RUNNING',last_checkpoint:{step:89},recent_summary:'Context Governor PASS',
 git:{head:'abc',branch:'main',status_summary:'dirty'},requested_sync_reason:'GATE_PASS'
});
assert.equal(p.protocol,'devexec.ops-sync');
assert.equal(p.dedupe_key.length,64);
const r=parseOpsSyncResponse({
 protocol:'devexec.ops-sync-response',schema_version:1,mission_id:'M1',
 decision:'CONTINUE',next_goal:'Implement minimal Notion round trip',priority:1,
 constraints:['same Mission','Notion is authority'],
 notion_read_at:'2026-08-21T01:00:00+09:00',notion_updated:false,sync_id:'SYNC-1'
});
assert.equal(r.decision,'CONTINUE');
assert.equal(r.mission_id,p.mission_id);
assert.throws(()=>parseOpsSyncResponse({...r,decision:'RUN'}),/invalid decision/);
console.log('DEVEXEC_OPS_SYNC_TYPED_PROTOCOL_V0_TEST_PASS');
