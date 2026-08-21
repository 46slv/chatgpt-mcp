import fs from "node:fs";
export function loadMissionEscalation(file){
 if(!file) return null;
 if(!fs.existsSync(file)) throw new Error("mission escalation file missing");
 const x=JSON.parse(fs.readFileSync(file,"utf8"));
 const allowed=new Set(["protocol","schema_version","mission_id","decision","reason","step_count","failure_count","completed_actions","evidence_keys","remaining_criteria","requested_help"]);
 for(const k of Object.keys(x)) if(!allowed.has(k)) throw new Error("unknown escalation field: "+k);
 if(x.protocol!=="dev-exec.mission-escalation"||x.schema_version!==1||x.decision!=="NEEDS_SUPERVISOR") throw new Error("invalid mission escalation");
 if(typeof x.mission_id!=="string"||!x.mission_id) throw new Error("mission_id required");
 return x;
}
export function appendMissionEscalationToReport(report,escalation){
 if(!escalation) return report;
 const compact=JSON.stringify(escalation);
 if(compact.length>12000) throw new Error("mission escalation too large");
 const marker="MISSION ESCALATION\n"+compact+"\nEND MISSION ESCALATION\n";
 const anchor="Request:\n";
 const i=report.lastIndexOf(anchor);
 if(i<0) throw new Error("report request anchor missing");
 return report.slice(0,i)+marker+"\n"+report.slice(i);
}
