import assert from 'node:assert/strict';
import {buildHeartbeatSupervisorPrompt,parseHeartbeatSupervisorResponse,sendHeartbeatOpsSync} from './devexec-heartbeat-transport.mjs';
const packet={protocol:'devexec.ops-sync',schema_version:1,mission_id:'MISSION-1',dev_exec_run_id:'RUN-1',machine:'TEST',project_root:'X',current_gate:'HEARTBEAT_V0',status:'RUNNING',last_checkpoint:null,recent_summary:null,git:{head:null,branch:null,status_summary:null},requested_sync_reason:'HEARTBEAT',dedupe_key:'abc'};
const response={protocol:'devexec.ops-sync-response',schema_version:1,mission_id:'MISSION-1',decision:'CONTINUE',next_goal:'continue mission',priority:1,constraints:['bounded'],notion_read_at:'2026-08-21T03:00:00+09:00',notion_updated:false,sync_id:'HB-1'};
const prompt=buildHeartbeatSupervisorPrompt(packet); assert.ok(prompt.includes('isolated heartbeat')); assert.ok(prompt.includes(JSON.stringify(packet)));
assert.equal(parseHeartbeatSupervisorResponse(JSON.stringify(response),'MISSION-1').sync_id,'HB-1');
await assert.rejects(async()=>parseHeartbeatSupervisorResponse(JSON.stringify({...response,mission_id:'OTHER'}),'MISSION-1'));
let seen=''; const sent=await sendHeartbeatOpsSync({packet,bridge_reply:async p=>{seen=p;return JSON.stringify(response);}}); assert.ok(seen.includes('HEARTBEAT_V0')); assert.equal(sent.response.decision,'CONTINUE');
console.log('DEVEXEC_HEARTBEAT_TRANSPORT_FAKE_BRIDGE_V0_TEST_PASS');
