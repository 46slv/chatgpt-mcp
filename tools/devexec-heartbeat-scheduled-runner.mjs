import fs from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {resolveLatestLeafRun,classifyHeartbeatLeaf} from "./devexec-heartbeat-scheduler.mjs";
function atomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+".tmp-"+process.pid+"-"+Date.now();fs.writeFileSync(tmp,JSON.stringify(value,null,2)+"\n","utf8");fs.renameSync(tmp,file);}
export function loadHeartbeatSchedulerConfig(file){const c=JSON.parse(fs.readFileSync(file,"utf8"));if(c.protocol!=="devexec.heartbeat-scheduler-config"||c.schema_version!==1)throw new Error("INVALID_CONFIG");if(!c.root_run_id||!c.state_dir||!c.result_file)throw new Error("MISSING_CONFIG_FIELD");return c;}
export function runScheduledHeartbeatCheck(c){const leaf=resolveLatestLeafRun({state_dir:c.state_dir,root_run_id:c.root_run_id});const guard=classifyHeartbeatLeaf(leaf.state);const r={protocol:"devexec.heartbeat-scheduler-result",schema_version:1,root_run_id:c.root_run_id,leaf_run_id:leaf.state.run_id,leaf_phase:leaf.state.phase||null,status:guard.safe?"READY":"SKIPPED",reason:guard.reason,action_invoked:false,at:new Date().toISOString()};atomic(c.result_file,r);return r;}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const f=process.argv[2];if(!f)throw new Error("CONFIG_REQUIRED");process.stdout.write(JSON.stringify(runScheduledHeartbeatCheck(loadHeartbeatSchedulerConfig(f)),null,2)+"\n");}
