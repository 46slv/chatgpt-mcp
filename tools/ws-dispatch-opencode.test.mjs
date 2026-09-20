import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WS_DISPATCH_JOB_PROTOCOL, WS_DISPATCH_SCHEMA_VERSION } from './ws-dispatch-core.mjs';
import { resolveOpenCodeExecutable, runOpenCodeWorker } from './ws-dispatch-opencode.mjs';

function job() {
  return { protocol: WS_DISPATCH_JOB_PROTOCOL, schema_version: WS_DISPATCH_SCHEMA_VERSION, job_id: 'runner-001', workspace: process.cwd(), lane: 'muse', authority: 'read-only', goal: 'Inspect.', done: 'Report.', reply: { mode: 'NONE', target_alias: null }, created_at: '2026-09-21T00:00:00.000Z' };
}
function fakeSpawn(code = 0) {
  return (command, args, options) => {
    assert.ok(command === 'opencode' || command === 'opencode.cmd');
    assert.ok(args.includes('--format'));
    assert.equal(options.shell, false);
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', code, null));
    return child;
  };
}

test('resolves Windows shim explicitly', () => {
  assert.equal(resolveOpenCodeExecutable('win32'), 'opencode.cmd');
  assert.equal(resolveOpenCodeExecutable('linux'), 'opencode');
});

test('captures deterministic evidence refs around a successful OpenCode process boundary', async () => {
  const evidence_dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-dispatch-evidence-'));
  const result = await runOpenCodeWorker({ job: job(), evidence_dir, spawnImpl: fakeSpawn(0), platform: 'linux' });
  assert.equal(result.state, 'COMPLETED');
  assert.deepEqual(result.evidence_refs, ['evidence/runner-001.opencode.jsonl','evidence/runner-001.opencode.stderr.log']);
  assert.equal(fs.existsSync(path.join(evidence_dir, 'runner-001.opencode.jsonl')), true);
});

test('non-zero OpenCode exit becomes FAILED with evidence preserved', async () => {
  const evidence_dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-dispatch-evidence-'));
  const result = await runOpenCodeWorker({ job: job(), evidence_dir, spawnImpl: fakeSpawn(7), platform: 'linux' });
  assert.equal(result.state, 'FAILED');
  assert.match(result.error, /exit_code=7/);
});
