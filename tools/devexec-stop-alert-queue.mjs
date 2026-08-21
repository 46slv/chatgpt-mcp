import fs from 'node:fs';
import path from 'node:path';
export function enqueueStopAlert(input={}){
 const dir=input.dir; const alert=input.alert;
 if(!dir||!alert||alert.protocol!=='devexec.stop-alert'||!alert.dedupe_key)throw new Error('dir and valid alert required');
 fs.mkdirSync(dir,{recursive:true});
 const file=path.join(dir,alert.dedupe_key+'.json');
 if(fs.existsSync(file))return {queued:false,deduped:true,file};
 const tmp=file+'.tmp-'+process.pid+'-'+Date.now();
 fs.writeFileSync(tmp,JSON.stringify(alert,null,2)+'\n','utf8'); fs.renameSync(tmp,file);
 return {queued:true,deduped:false,file};
}
export function listPendingStopAlerts(dir){
 if(!dir||!fs.existsSync(dir))return [];
 return fs.readdirSync(dir).filter(x=>x.endsWith('.json')).sort().map(name=>({file:path.join(dir,name),alert:JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'))}));
}
export function markStopAlertDelivered(input={}){
 const file=input.file; const receiptDir=input.receipt_dir; const delivery=input.delivery||{};
 if(!file||!receiptDir||!fs.existsSync(file))throw new Error('pending alert file required');
 const alert=JSON.parse(fs.readFileSync(file,'utf8')); fs.mkdirSync(receiptDir,{recursive:true});
 const receipt={protocol:'devexec.stop-alert-receipt',schema_version:1,dedupe_key:alert.dedupe_key,mission_id:alert.mission_id,run_id:alert.run_id,delivered_at:new Date().toISOString(),delivery};
 const target=path.join(receiptDir,alert.dedupe_key+'.json'); fs.writeFileSync(target,JSON.stringify(receipt,null,2)+'\n','utf8');
 fs.renameSync(file,file+'.delivered-'+Date.now()); return {receipt,file:target};
}
