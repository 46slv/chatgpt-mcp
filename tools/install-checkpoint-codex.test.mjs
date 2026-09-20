import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildHookConfig, install, mergeHooks } from './install-checkpoint-codex.mjs';

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
