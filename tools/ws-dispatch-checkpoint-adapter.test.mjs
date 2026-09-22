import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { bindWorkspace, pendingCheckpoints } from './checkpoint-core.mjs';
import {
  claimNextJob,
  submitJob,
  writeResult,
} from './ws-dispatch-core.mjs';
import {
  projectWsDispatchResultToCheckpoint,
  readWsDispatchCheckpointLink,
} from './ws-dispatch-checkpoint-adapter.mjs';

const NOW = '2026-09-23T01:00:00.000Z';

function fixture(reply = { mode: 'REPORT', target_alias: 'ws-checkpoint' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-checkpoint-adapter-'));
  const workspace = path.join(root, 'workspace');
  const dispatchRoot = path.join(root, 'dispatch');
  const stateRoot = path.join(root, 'checkpoint-state');
  fs.mkdirSync(workspace, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: workspace });
  execFileSync('git', ['config', 'user.name', 'WS Test'], { cwd: workspace });
  fs.writeFileSync(path.join(workspace, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: workspace });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: workspace });
  const registry = path.join(root, 'targets.json');
  fs.writeFileSync(registry, JSON.stringify({
    schema_version: 1,
    default_target: 'ws-checkpoint',
    targets: {
      'ws-checkpoint': {
        transport: 'chatgpt-web',
        chat_url: 'https://chatgpt.com/c/ws-checkpoint',
        conversation_id: 'ws-checkpoint',
      },
    },
  }));
  bindWorkspace({
    workspace,
    mission_id: 'MISSION-WS',
    target_alias: 'ws-checkpoint',
    stateRoot,
    registryPath: registry,
    now: () => NOW,
  });
  const job = {
    protocol: 'ws-dispatch.job',
    schema_version: 1,
    job_id: 'job-001',
    workspace,
    lane: 'muse',
    authority: 'workspace-write',
    goal: 'Repair one bounded defect.',
    done: 'Focused verification passes.',
    reply,
    created_at: NOW,
  };
  submitJob({ root: dispatchRoot, job });
  claimNextJob({ root: dispatchRoot });
  writeResult({
    root: dispatchRoot,
    result: {
      protocol: 'ws-dispatch.result',
      schema_version: 1,
      job_id: job.job_id,
      state: 'COMPLETED',
      lane: job.lane,
      started_at: NOW,
      finished_at: NOW,
      summary: 'The bounded repair and focused verification completed.',
      evidence_refs: ['evidence:focused-test'],
      error: null,
    },
  });
  return { root, workspace, dispatchRoot, stateRoot, job };
}

test('terminal REPORT becomes one local-worker checkpoint and replay is cached', () => {
  const f = fixture();
  try {
    const first = projectWsDispatchResultToCheckpoint({ root: f.dispatchRoot, job_id: f.job.job_id, stateRoot: f.stateRoot, now: () => NOW });
    assert.equal(first.status, 'CREATED');
    assert.equal(first.event.mode, 'REPORT');
    assert.equal(first.event.producer.kind, 'local-worker');
    assert.equal(first.event.producer.session_id, f.job.job_id);
    assert.deepEqual(first.event.evidence_refs, ['ws-dispatch-result:job-001', 'evidence:focused-test']);
    assert.equal(first.link.checkpoint_id, first.event.checkpoint_id);
    assert.equal(pendingCheckpoints({ workspace: f.workspace, stateRoot: f.stateRoot }).length, 1);

    const second = projectWsDispatchResultToCheckpoint({ root: f.dispatchRoot, job_id: f.job.job_id, stateRoot: f.stateRoot, now: () => NOW });
    assert.equal(second.status, 'CACHED');
    assert.equal(second.link.checkpoint_id, first.link.checkpoint_id);
    assert.equal(pendingCheckpoints({ workspace: f.workspace, stateRoot: f.stateRoot }).length, 1);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('CONSULT keeps checkpoint delivery advisory and supplies a bounded question', () => {
  const f = fixture({ mode: 'CONSULT', target_alias: 'ws-checkpoint' });
  try {
    const projected = projectWsDispatchResultToCheckpoint({ root: f.dispatchRoot, job_id: f.job.job_id, stateRoot: f.stateRoot, now: () => NOW });
    assert.equal(projected.event.mode, 'CONSULT');
    assert.match(projected.event.semantic.question, /bounded next step/u);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('reply NONE creates no checkpoint link or checkpoint event', () => {
  const f = fixture({ mode: 'NONE', target_alias: null });
  try {
    const projected = projectWsDispatchResultToCheckpoint({ root: f.dispatchRoot, job_id: f.job.job_id, stateRoot: f.stateRoot, now: () => NOW });
    assert.equal(projected.status, 'SKIPPED');
    assert.equal(readWsDispatchCheckpointLink({ root: f.dispatchRoot, job_id: f.job.job_id }).status, 'NOT_LINKED');
    assert.equal(pendingCheckpoints({ workspace: f.workspace, stateRoot: f.stateRoot }).length, 0);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('target drift fails before claim and never falls back to a default target', () => {
  const f = fixture({ mode: 'REPORT', target_alias: 'different-target' });
  try {
    assert.throws(
      () => projectWsDispatchResultToCheckpoint({ root: f.dispatchRoot, job_id: f.job.job_id, stateRoot: f.stateRoot, now: () => NOW }),
      /does not match the immutable workspace checkpoint binding/u,
    );
    assert.equal(readWsDispatchCheckpointLink({ root: f.dispatchRoot, job_id: f.job.job_id }).status, 'NOT_LINKED');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('existing link claim is ambiguous and never creates a second checkpoint', () => {
  const f = fixture();
  try {
    const directory = path.join(f.dispatchRoot, 'checkpoint-links');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'job-001.claim.json'), JSON.stringify({ job_id: 'job-001' }));
    const projected = projectWsDispatchResultToCheckpoint({ root: f.dispatchRoot, job_id: f.job.job_id, stateRoot: f.stateRoot, now: () => NOW });
    assert.equal(projected.status, 'IN_FLIGHT_AMBIGUOUS');
    assert.equal(pendingCheckpoints({ workspace: f.workspace, stateRoot: f.stateRoot }).length, 0);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
