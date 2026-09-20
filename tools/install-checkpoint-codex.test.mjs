import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildHookConfig, buildMcpRegistration, codexCliCommand, ensureMcpRegistration, install, isTemporaryRoot, mergeHooks } from './install-checkpoint-codex.mjs';

test('hook merge preserves existing hooks and is idempotent', () => {
  const commands=buildHookConfig({repoRoot:'C:\\repo'});
  const existing={hooks:{Stop:[{hooks:[{type:'command',command:'node existing.mjs'}]}]}};
  const once=mergeHooks(existing,commands); const twice=mergeHooks(once,commands);
  assert.equal(once.hooks.Stop.length,2); assert.equal(twice.hooks.Stop.length,2);
  assert.equal(once.hooks.Stop[0].hooks[0].command,'node existing.mjs');
  assert.equal(once.hooks.SessionStart.length,1);
});

test('dry run performs no user mutation', () => {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'checkpoint-install-'));
  const fakeRepo=path.join(temp,'repo'); const skill=path.join(fakeRepo,'.agents','skills','checkpoint-autoreport'); fs.mkdirSync(skill,{recursive:true}); fs.writeFileSync(path.join(skill,'SKILL.md'),'x');
  const home=path.join(temp,'home'); const plan=install({repoRoot:fakeRepo,home,dryRun:true});
  assert.match(plan.hooksFile,/hooks\.json$/); assert.equal(fs.existsSync(home),false);
});
test('actual install refuses a temporary checkout and dry run exposes MCP plan', () => {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'checkpoint-install-temp-'));
  const fakeRepo=path.join(temp,'repo');
  const skill=path.join(fakeRepo,'.agents','skills','checkpoint-autoreport');
  fs.mkdirSync(skill,{recursive:true});
  fs.writeFileSync(path.join(skill,'SKILL.md'),'x');
  fs.mkdirSync(path.join(fakeRepo,'dist'),{recursive:true});
  fs.writeFileSync(path.join(fakeRepo,'dist','index.js'),'// built');
  const plan=install({repoRoot:fakeRepo,home:path.join(temp,'home'),dryRun:true});
  assert.equal(plan.temporaryRoot,true);
  assert.equal(plan.mcpRegistration.name,'checkpoint_autoreport');
  assert.throws(()=>install({repoRoot:fakeRepo,home:path.join(temp,'home')}),/temporary checkout/);
});
test('MCP registration is idempotent and refuses drift', () => {
  assert.equal(codexCliCommand('win32'),'codex.exe');
  assert.equal(codexCliCommand('linux'),'codex');
  const registration=buildMcpRegistration({repoRoot:'C:\\repo',nodePath:'C:\\node.exe'});
  const calls=[];
  const missing=(cmd,args)=>{
    calls.push([cmd,args]);
    if(args[1]==='get') throw new Error('missing');
    return '';
  };
  assert.equal(ensureMcpRegistration(registration,{run:missing}).status,'REGISTERED');
  assert.equal(calls[0][0],codexCliCommand());
  assert.equal(calls.at(-1)[1][1],'add');

  const same=()=>JSON.stringify({transport:{type:'stdio',command:'C:\\node.exe',args:['C:\\repo\\dist\\index.js']}});
  assert.equal(ensureMcpRegistration(registration,{run:same}).status,'ALREADY_REGISTERED');

  const drift=()=>JSON.stringify({transport:{type:'stdio',command:'C:\\other.exe',args:['x']}});
  assert.throws(()=>ensureMcpRegistration(registration,{run:drift}),/different transport\/command\/args/);
});
test('temporary-root classifier is explicit', () => {
  assert.equal(isTemporaryRoot(path.join(os.tmpdir(),'x')),true);
});
