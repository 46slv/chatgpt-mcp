import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

import {openMissionControl} from "./devexec-mission-control.mjs";
import {resolveMissionEntryIdentity} from "./devexec-mission-entry.mjs";

const HERE=path.dirname(fileURLToPath(import.meta.url));
const AGENT=path.join(HERE,"local-agent-facade.mjs");
const LOOP=path.join(HERE,"dev-exec-loop.mjs");
const BASE=process.env.LOCALAPPDATA||path.join(os.homedir(),"AppData","Local");
const argv=process.argv.slice(2);
let target=null;
let dry=false;let reportOnly=false;
const parts=[];
for(let i=0;i<argv.length;i++){
 if(argv[i]==="--target"){target=argv[++i];if(!target)throw new Error("target required");}
 else if(argv[i]==="--dry-run"){dry=true;}
 else if(argv[i]==="--report-only"){reportOnly=true;}
 else parts.push(argv[i]);
}
const goal=parts.join(" ").trim();
if(!goal)throw new Error("goal required");
const id=process.env.DEV_EXEC_RUN_ID||"DEV-EXEC-GOAL-"+Date.now();
const identity=resolveMissionEntryIdentity({
 run_id:id,
 parent_run_id:process.env.DEV_EXEC_PARENT_RUN_ID||null,
 mission_id:process.env.DEV_EXEC_MISSION_ID||null,
});
const env={...process.env,DEV_EXEC_RUN_ID:id,DEV_EXEC_MISSION_ID:identity.mission_id};
if(identity.parent_run_id)env.DEV_EXEC_PARENT_RUN_ID=identity.parent_run_id;
if(target)env.DEV_EXEC_TARGET_ALIAS=target;
const r=spawnSync(process.execPath,[AGENT,"start",goal],{encoding:"utf8",env,windowsHide:true});
let agent=null;
try{agent=JSON.parse((r.stdout||"").trim());}catch{}
if(!agent||!agent.run_id)throw new Error("local agent start failed");
const mission=openMissionControl({
 base:BASE,
 mission_id:identity.mission_id,
 run_id:id,
 parent_run_id:identity.parent_run_id,
});
if(agent.decision==="COMPLETE"){
 console.log(JSON.stringify({run_id:id,mission_id:identity.mission_id,parent_run_id:identity.parent_run_id,agent_run_id:agent.run_id,decision:"COMPLETE",supervisor_used:false,mission_created:mission.created},null,2));
 process.exit(0);
}
if(agent.decision!=="NEEDS_SUPERVISOR")throw new Error("unsupported decision: "+agent.decision);
const dir=path.join(BASE,"ChatGPTMCPProbe","dev-exec-runs",id);
fs.mkdirSync(dir,{recursive:true});
const owner={protocol:"devexec.local-agent-owner",schema_version:1,dev_exec_run_id:id,mission_id:identity.mission_id,parent_run_id:identity.parent_run_id,agent_run_id:agent.run_id,worker_run_id:agent.worker_run_id,goal};
fs.writeFileSync(path.join(dir,"local-agent-owner.json"),JSON.stringify(owner,null,2)+"\n");
if(reportOnly)env.DEV_EXEC_REPORT_ONLY="1";
if(dry){
 console.log(JSON.stringify({...owner,decision:"NEEDS_SUPERVISOR",supervisor_used:false,mission_created:mission.created},null,2));
 process.exit(2);
}
env.DEV_EXEC_PURPOSE="Supervise Local Agent only after local escalation.";
env.DEV_EXEC_TARGET="Apply bounded typed repair, then resume Local Agent "+agent.run_id+". Keep ordinary execution local.";
const loop=spawnSync(process.execPath,[LOOP],{stdio:"inherit",env,windowsHide:true});
process.exit(loop.status===null?2:loop.status);
