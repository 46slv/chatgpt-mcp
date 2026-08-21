import fs from 'node:fs';
export function loadOpsSyncPacket(file){
 if(!file)return null;
 if(!fs.existsSync(file))throw new Error('ops sync packet file missing');
 const x=JSON.parse(fs.readFileSync(file,'utf8'));
 if(x.protocol!=='devexec.ops-sync'||x.schema_version!==1)throw new Error('invalid ops sync packet');
 if(typeof x.mission_id!=='string'||!x.mission_id)throw new Error('mission_id required');
 if(typeof x.dedupe_key!=='string'||!x.dedupe_key)throw new Error('dedupe_key required');
 return x;
}
export function appendOpsSyncToReport(report,packet){
 if(!packet)return report;
 const compact=JSON.stringify(packet);
 if(compact.length>12000)throw new Error('ops sync packet too large');
 const block='OPS SYNC PACKET'+String.fromCharCode(10)+compact+String.fromCharCode(10)+'END OPS SYNC PACKET'+String.fromCharCode(10);
 const anchor='Request:'+String.fromCharCode(10);
 const i=report.lastIndexOf(anchor);
 if(i<0)throw new Error('report request anchor missing');
 return report.slice(0,i)+block+String.fromCharCode(10)+report.slice(i);
}
