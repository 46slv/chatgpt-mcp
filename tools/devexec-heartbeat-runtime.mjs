import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {inspectHeartbeatSafety,buildHeartbeatPacket,persistHeartbeatResult} from './devexec-heartbeat.mjs';
export function runHeartbeatTick(i={}){
 const mission=i.mission_id; const run=i.dev_exec_run_id; const root=path.resolve(i.project_root||'.'); const stateFile=i.state_file; const outDir=i.out_dir;
 if(!mission||!run||!stateFile||!outDir)throw new Error('mission_id dev_exec_run_id state_file out_dir required');
 fs.mkdirSync(outDir,{recursive:true}); const resultFile=path.join(outDir,'last-result.json');
 if(!fs.existsSync(stateFile)){const v={protocol:'devexec.heartbeat-result',schema_version:1,mission_id:mission,dev_exec_run_id:run,status:'SKIPPED',reason:'STATE_MISSING',at:new Date().toISOString()}; persistHeartbeatResult(resultFile,v); return v;}
 const state=JSON.parse(fs.readFileSync(stateFile,'utf8')); const safety=inspectHeartbeatSafety(state);
 if(!safety.safe){const v={protocol:'devexec.heartbeat-result',schema_version:1,mission_id:mission,dev_exec_run_id:run,status:'SKIPPED',reason:safety.reason,source_phase:state.phase||null,source_step:state.step??null,at:new Date().toISOString()}; persistHeartbeatResult(resultFile,v); return v;}
 const packet=buildHeartbeatPacket({mission_id:mission,dev_exec_run_id:run,machine:i.machine||process.env.COMPUTERNAME||os.hostname(),project_root:root,state,slot:i.slot});
 const packetFile=path.join(outDir,'ops-sync.json'); persistHeartbeatResult(packetFile,packet); const v={protocol:'devexec.heartbeat-result',schema_version:1,mission_id:mission,dev_exec_run_id:run,status:'READY',reason:'SAFE',packet_file:packetFile,dedupe_key:packet.dedupe_key,source_phase:state.phase||null,source_step:state.step??null,at:new Date().toISOString()}; persistHeartbeatResult(resultFile,v); return v;
}
