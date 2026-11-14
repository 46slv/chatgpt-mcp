import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {acquireDispatcherLock,releaseDispatcherLock} from './ws-dispatch-core.mjs';
const root=()=>fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-guard-'));
const pathOf=(r,n='dispatcher.lock')=>path.join(r,n);
const payload=(pid=111,started_at='2026-09-21T00:00:00.000Z')=>JSON.stringify({protocol:'ws-dispatch.lock',schema_version:1,pid,started_at})+'\n';
test('malformed lock is retained and requires reconciliation',()=>{const r=root();fs.writeFileSync(pathOf(r),'{broken');assert.throws(()=>acquireDispatcherLock({root:r,isPidAlive:()=>false}),/unknown|invalid|reconcil/i);assert.equal(fs.readFileSync(pathOf(r),'utf8'),'{broken');});
test('indeterminate pid is retained',()=>{const r=root(),before=payload();fs.writeFileSync(pathOf(r),before);assert.throws(()=>acquireDispatcherLock({root:r,isPidAlive:()=>undefined}),/unknown|reconcil/i);assert.equal(fs.readFileSync(pathOf(r),'utf8'),before);});
test('invalid pid is never treated as dead',()=>{const r=root(),before=payload(0);fs.writeFileSync(pathOf(r),before);assert.throws(()=>acquireDispatcherLock({root:r,isPidAlive:()=>false}),/unknown|invalid|reconcil/i);assert.equal(fs.readFileSync(pathOf(r),'utf8'),before);});
test('unfinished recovery guard blocks fresh dispatch',()=>{const r=root();fs.writeFileSync(pathOf(r,'dispatcher.recovery.lock'),'prior');assert.throws(()=>acquireDispatcherLock({root:r}),/recovery|reconcil/i);assert.equal(fs.existsSync(pathOf(r)),false);});
test('known dead lock can be recovered and guard is released',()=>{const r=root();fs.writeFileSync(pathOf(r),payload());const lock=acquireDispatcherLock({root:r,pid:222,isPidAlive:()=>false});assert.equal(lock.pid,222);assert.equal(fs.existsSync(pathOf(r,'dispatcher.recovery.lock')),false);assert.equal(releaseDispatcherLock(lock),true);});
test('release rejects changed start identity for same pid',()=>{const r=root(),first=acquireDispatcherLock({root:r,pid:222});fs.writeFileSync(pathOf(r),payload(222,'2026-09-21T00:00:00.000Z'));assert.throws(()=>releaseDispatcherLock(first),/ownership changed/);assert.equal(fs.existsSync(pathOf(r)),true);});

import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const childCode = `
import fs from 'node:fs';
const [moduleUrl,root]=process.argv.slice(1);
const {acquireDispatcherLock,releaseDispatcherLock}=await import(moduleUrl);
while (!fs.existsSync(root+'/go')) await new Promise(r=>setTimeout(r,5));
try {
 const l=acquireDispatcherLock({root,isPidAlive:(p)=>p===111?false:true});
 console.log('ACQUIRED');await new Promise(r=>setTimeout(r,1000));releaseDispatcherLock(l);
} catch(e) {console.log('REJECTED');}
`;
function runChild(moduleUrl,r) {
 const c=spawn(process.execPath,['--input-type=module','-e',childCode,moduleUrl,r],{stdio:['ignore','pipe','pipe']});
 let out='',err='';c.stdout.on('data',x=>out+=x);c.stderr.on('data',x=>err+=x);
 return new Promise((resolve,reject)=>{c.on('error',reject);c.on('exit',code=>code===0?resolve(out.trim()):reject(new Error(err)));});
}
test('two real processes recovering the same stale lock yield one owner',async()=>{
 const moduleUrl=pathToFileURL(path.resolve('tools/ws-dispatch-core.mjs')).href;
 for(let i=0;i<3;i++) {
  const r=root();fs.writeFileSync(pathOf(r),payload());
  const a=runChild(moduleUrl,r),b=runChild(moduleUrl,r);
  await new Promise(resolve=>setTimeout(resolve,150));fs.writeFileSync(path.join(r,'go'),'go');
  const result=await Promise.all([a,b]);
  assert.equal(result.filter(x=>x==='ACQUIRED').length,1,JSON.stringify(result));
  assert.equal(result.filter(x=>x==='REJECTED').length,1,JSON.stringify(result));
 }
});
test('release rejects another owner token with identical pid and start',()=>{
 const r=root(),lock=acquireDispatcherLock({root:r,pid:222});const current=JSON.parse(fs.readFileSync(pathOf(r),'utf8'));
 current.owner_token='other-owner';fs.writeFileSync(pathOf(r),JSON.stringify(current));
 assert.throws(()=>releaseDispatcherLock(lock),/ownership changed/);assert.equal(fs.existsSync(pathOf(r)),true);
});
test('release does not touch lock while recovery guard is held',()=>{
 const r=root(),lock=acquireDispatcherLock({root:r,pid:222});const before=fs.readFileSync(pathOf(r),'utf8');
 fs.writeFileSync(pathOf(r,'dispatcher.recovery.lock'),'other');assert.throws(()=>releaseDispatcherLock(lock),/recovery|reconcil/i);
 assert.equal(fs.readFileSync(pathOf(r),'utf8'),before);
});

test('process crash during stale recovery retains guard and original lock',async()=>{
 const r=root(),before=payload();fs.writeFileSync(pathOf(r),before);
 const moduleUrl=pathToFileURL(path.resolve('tools/ws-dispatch-core.mjs')).href;
 const crashCode=`const [url,root]=process.argv.slice(1);const {acquireDispatcherLock}=await import(url);acquireDispatcherLock({root,isPidAlive:()=>process.exit(77)});`;
 const child=spawn(process.execPath,['--input-type=module','-e',crashCode,moduleUrl,r],{stdio:'ignore'});
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve)});
 assert.equal(code,77);assert.equal(fs.readFileSync(pathOf(r),'utf8'),before);
 assert.equal(fs.existsSync(pathOf(r,'dispatcher.recovery.lock')),true);
 assert.throws(()=>acquireDispatcherLock({root:r,isPidAlive:()=>false}),/recovery|reconcil/i);
 assert.equal(fs.readFileSync(pathOf(r),'utf8'),before);
});

test('crash after stale unlink preserves recovery guard and blocks reacquisition',async()=>{
 const r=root();fs.writeFileSync(pathOf(r),payload());const u=pathToFileURL(path.resolve('tools/ws-dispatch-core.mjs')).href;
 const code=`import fs from 'node:fs';const [url,root]=process.argv.slice(1);const old=fs.unlinkSync;fs.unlinkSync=(p,...a)=>{old(p,...a);if(String(p).endsWith('dispatcher.lock'))process.exit(78)};const {acquireDispatcherLock}=await import(url);acquireDispatcherLock({root,isPidAlive:()=>false});`;
 const child=spawn(process.execPath,['--input-type=module','-e',code,u,r],{stdio:'ignore'});const exit=await new Promise((yes,no)=>{child.on('error',no);child.on('exit',yes)});
 assert.equal(exit,78);assert.equal(fs.existsSync(pathOf(r)),false);assert.equal(fs.existsSync(pathOf(r,'dispatcher.recovery.lock')),true);
 assert.throws(()=>acquireDispatcherLock({root:r,isPidAlive:()=>false}),/recovery|reconcil/i);
});
test('crash after new lock creation retains both lock and guard',async()=>{
 const r=root();fs.writeFileSync(pathOf(r),payload());const u=pathToFileURL(path.resolve('tools/ws-dispatch-core.mjs')).href;
 const code=`import fs from 'node:fs';const [url,root]=process.argv.slice(1);const old=fs.unlinkSync;fs.unlinkSync=(p,...a)=>{if(String(p).endsWith('dispatcher.recovery.lock'))process.exit(79);return old(p,...a)};const {acquireDispatcherLock}=await import(url);acquireDispatcherLock({root,isPidAlive:()=>false});`;
 const child=spawn(process.execPath,['--input-type=module','-e',code,u,r],{stdio:'ignore'});const exit=await new Promise((yes,no)=>{child.on('error',no);child.on('exit',yes)});
 assert.equal(exit,79);assert.equal(fs.existsSync(pathOf(r)),true);assert.equal(fs.existsSync(pathOf(r,'dispatcher.recovery.lock')),true);
 const current=fs.readFileSync(pathOf(r),'utf8');const owner=JSON.parse(current);
 assert.equal(owner.pid,child.pid);assert.equal(typeof owner.owner_token,'string');assert.ok(owner.owner_token.length>0);assert.notEqual(current,payload());
 assert.throws(()=>acquireDispatcherLock({root:r,isPidAlive:()=>false}),/recovery|reconcil/i);assert.equal(fs.readFileSync(pathOf(r),'utf8'),current);
});
