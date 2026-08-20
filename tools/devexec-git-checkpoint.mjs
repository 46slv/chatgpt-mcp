import {execFileSync} from 'node:child_process';
import path from 'node:path';
function git(root,args){return execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();}
export function createGitCheckpoint(i={}){
 const root=path.resolve(i.root||'.'); const files=i.files;
 if(!Array.isArray(files)||files.length<1||files.length>64)throw new Error('files required');
 const clean=files.map(x=>String(x).replaceAll('\\','/'));
 for(const f of clean)if(path.isAbsolute(f)||f==='..'||f.startsWith('../')||f.includes('/../'))throw new Error('unsafe path');
 if(git(root,['diff','--cached','--name-only']))throw new Error('preexisting staged changes');
 const before=git(root,['rev-parse','HEAD']); git(root,['add','--',...clean]);
 const staged=git(root,['diff','--cached','--name-only']).split(/\r?\n/).filter(Boolean);
 if(!staged.length)throw new Error('nothing staged');
 const allowed=new Set(clean); if(staged.some(x=>!allowed.has(x)))throw new Error('unexpected staged path');
 const msg=String(i.message||'devexec checkpoint').trim(); if(!msg)throw new Error('message required');
 git(root,['commit','-m',msg,'--',...clean]); const head=git(root,['rev-parse','HEAD']);
 return {protocol:'devexec.git-checkpoint',schema_version:1,head_before:before,head_after:head,files:staged,message:msg};
}
