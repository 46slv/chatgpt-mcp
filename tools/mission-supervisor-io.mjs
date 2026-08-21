import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
function atomicJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+".tmp-"+process.pid+"-"+crypto.randomBytes(3).toString("hex");fs.writeFileSync(tmp,JSON.stringify(value,null,2)+"\n","utf8");fs.renameSync(tmp,file);}
export function writeMissionEscalation(file,x){if(!file||x?.protocol!=="dev-exec.mission-escalation"||x?.schema_version!==1||x?.decision!=="NEEDS_SUPERVISOR")throw new Error("invalid escalation");atomicJson(file,x);return file;}
export function writeMissionRepair(file,x){if(!file||x?.protocol!=="dev-exec.mission-repair"||x?.schema_version!==1)throw new Error("invalid repair");atomicJson(file,x);return file;}
export function consumeMissionRepair(file,missionId,expectedStep){if(!fs.existsSync(file))return null;const x=JSON.parse(fs.readFileSync(file,"utf8"));if(x.protocol!=="dev-exec.mission-repair"||x.schema_version!==1)throw new Error("invalid repair");if(x.mission_id!==missionId)throw new Error("repair mission id mismatch");if(x.expected_step_count!==expectedStep)throw new Error("stale repair");const consumed=file+".consumed-"+Date.now();fs.renameSync(file,consumed);return {...x,consumed_file:consumed};}
