import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { bindWorkspace, dispatchCheckpoint, saveCheckpoint } from './checkpoint-core.mjs';
import { handleSessionStart } from './checkpoint-codex-session-hook.mjs';
import { handleStop } from './checkpoint-codex-stop-hook.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-hooks-'));
  const workspace = path.join(root, 'repo'); fs.mkdirSync(workspace);
  const git = (args) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }).trim();
  git(['init']); git(['config', 'user.email', 'hooks@test.local']); git(['config', 'user.name', 'Hooks Test']);
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'x\n'); git(['add','.']); git(['commit','-m','base']);
  const registryPath = path.join(root, 'targets.json');
  fs.writeFileSync(registryPath, JSON.stringify({ schema_version:1, default_target:'x', targets:{ x:{ transport:'chatgpt-web', chat_url:'https://chatgpt.com/c/hook-target', conversation_id:'hook-target' } } }));
  return { root, workspace, stateRoot:path.join(root,'state'), registryPath };
}

test('SessionStart records identity and Stop blocks until current session checkpoint exists', async () => {
  const f=fixture(); const env={ CHECKPOINT_AUTOREPORT_STATE_ROOT:f.stateRoot };
  assert.deepEqual(handleSessionStart({cwd:f.workspace,session_id:'s1',source:'startup',model:'gpt'},env),{continue:true});
  bindWorkspace({workspace:f.workspace,mission_id:'M-HOOK',stateRoot:f.stateRoot,registryPath:f.registryPath});
  assert.equal(handleStop({cwd:f.workspace,session_id:'s1',stop_hook_active:false},env).decision,'block');
  const event=saveCheckpoint({workspace:f.workspace,next:'n',approach:'a',stateRoot:f.stateRoot});
  assert.equal(handleStop({cwd:f.workspace,session_id:'s1',stop_hook_active:false},env).decision,'block');
  assert.equal(handleStop({cwd:f.workspace,session_id:'s1',stop_hook_active:true},env).continue,true);
  await dispatchCheckpoint({event,stateRoot:f.stateRoot,send:async()=>({chat_id:'hook-target',response:''})});
  assert.deepEqual(handleStop({cwd:f.workspace,session_id:'s1',stop_hook_active:false},env),{continue:true});
});

test('Stop does not enforce unbound workspaces and avoids infinite continuation', () => {
  const f=fixture(); const env={ CHECKPOINT_AUTOREPORT_STATE_ROOT:f.stateRoot };
  assert.deepEqual(handleStop({cwd:f.workspace,session_id:'s2',stop_hook_active:false},env),{continue:true});
  handleSessionStart({cwd:f.workspace,session_id:'s2'},env);
  bindWorkspace({workspace:f.workspace,mission_id:'M-HOOK-2',stateRoot:f.stateRoot,registryPath:f.registryPath});
  const first=handleStop({cwd:f.workspace,session_id:'s2',stop_hook_active:false},env); assert.equal(first.decision,'block');
  const second=handleStop({cwd:f.workspace,session_id:'s2',stop_hook_active:true},env); assert.equal(second.continue,true); assert.match(second.systemMessage,/no checkpoint/);
});
