import fs from 'node:fs';
export function loadStopAlert(file){
 if(!file||!fs.existsSync(file))return null;
 const x=JSON.parse(fs.readFileSync(file,'utf8'));
 if(x.protocol!=='devexec.stop-alert'||x.schema_version!==1)throw new Error('invalid stop alert protocol');
 for(const k of ['mission_id','run_id','machine','project_root','stop_type','reason','requested_human_action','dedupe_key'])if(typeof x[k]!=='string'||!x[k])throw new Error(k+' required');
 return x;
}
export function appendStopAlertToReport(report,alert){
 if(!alert)return report; const body=JSON.stringify(alert); if(body.length>12000)throw new Error('stop alert too large');
 const block=['STOP ALERT',body,'END STOP ALERT'].join('\n'); const marker='Request:\n'; const i=report.indexOf(marker);
 return i<0?report+'\n\n'+block:report.slice(0,i)+block+'\n\n'+report.slice(i);
}
