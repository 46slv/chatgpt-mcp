import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { bindWorkspace } from './checkpoint-core.mjs';
import { connectTerminalResultToCheckpoint } from './ws-dispatch-checkpoint-delivery.mjs';
import { claimNextJob, submitJob, writeResult } from './ws-dispatch-core.mjs';

function terminalFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-dispatch-delivery-'));
  const workspace = path.join(root, 'workspace');
  const dispatchRoot = path.join(root, 'dispatch');
  const stateRoot = path.join(root, 'checkpoint-state');
  fs.mkdirSync(workspace, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: workspace });
  execFileSync('git', ['config', 'user.name', 'WS Test'], { cwd: workspace });
  fs.writeFileSync(path.join(workspace, 'README.md'), '# delivery fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: workspace });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: workspace });
  const registry = path.join(root, 'targets.json');
  fs.writeFileSync(registry, JSON.stringify({
    schema_version: 1,
    default_target: 'delivery-target',
    targets: {
      'delivery-target': {
        transport: 'chatgpt-web',
        chat_url: 'https://chatgpt.com/c/delivery-target',
        conversation_id: 'delivery-target',
      },
    },
  }));
  bindWorkspace({ workspace, mission_id: 'MISSION-DELIVERY', target_alias: 'delivery-target', stateRoot, registryPath: registry });
  const job = {
    protocol: 'ws-dispatch.job', schema_version: 1, job_id: 'delivery-001', workspace,
    lane: 'muse', authority: 'workspace-write', goal: 'Repair fixture.', done: 'Focused test passes.',
    reply: { mode: 'REPORT', target_alias: 'delivery-target' }, created_at: '2026-09-23T00:00:00.000Z',
  };
  submitJob({ root: dispatchRoot, job });
  claimNextJob({ root: dispatchRoot });
  writeResult({
    root: dispatchRoot,
    result: {
      protocol: 'ws-dispatch.result', schema_version: 1, job_id: job.job_id, state: 'COMPLETED', lane: 'muse',
      started_at: '2026-09-23T00:00:01.000Z', finished_at: '2026-09-23T00:00:02.000Z',
      summary: 'pass', evidence_refs: ['evidence/delivery-001.log'], error: null,
    },
  });
  return { root, dispatchRoot, stateRoot, job };
}

test('terminal REPORT uses the existing checkpoint delivery state machine exactly once', async () => {
  const fixture = terminalFixture();
  let sends = 0;
  const send = async () => {
    sends += 1;
    return { chat_id: 'delivery-target', response: '' };
  };
  try {
    const first = await connectTerminalResultToCheckpoint({
      root: fixture.dispatchRoot,
      job_id: fixture.job.job_id,
      stateRoot: fixture.stateRoot,
      send,
    });
    assert.equal(first.projection.status, 'CREATED');
    assert.equal(first.delivery.status, 'DELIVERED');
    const second = await connectTerminalResultToCheckpoint({
      root: fixture.dispatchRoot,
      job_id: fixture.job.job_id,
      stateRoot: fixture.stateRoot,
      send,
    });
    assert.equal(second.projection.status, 'CACHED');
    assert.equal(second.delivery.status, 'CACHED');
    assert.equal(sends, 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
