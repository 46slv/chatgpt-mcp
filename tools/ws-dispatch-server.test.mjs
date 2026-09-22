import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  claimNextJob,
  getJobStatus,
  submitJob,
} from './ws-dispatch-core.mjs';
import { serveDispatcher } from './ws-dispatch-server.mjs';

function tempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ws-dispatch-serve-${label}-`));
}

function job(job_id, workspace) {
  return {
    protocol: 'ws-dispatch.job',
    schema_version: 1,
    job_id,
    workspace,
    lane: 'muse',
    authority: 'read-only',
    goal: 'Inspect the disposable fixture.',
    done: 'Return a terminal receipt.',
    reply: { mode: 'NONE', target_alias: null },
    created_at: '2026-09-23T00:00:00.000Z',
  };
}

test('resident dispatcher processes one job, connects its terminal result once, then waits without spinning', async () => {
  const root = tempRoot('process');
  submitJob({ root, job: job('resident-001', root) });
  const controller = new AbortController();
  const connected = [];
  let waits = 0;
  const summary = await serveDispatcher({
    root,
    checkpointStateRoot: path.join(root, 'checkpoint-state'),
    signal: controller.signal,
    runner: async () => ({ state: 'COMPLETED', summary: 'pass', evidence_refs: [], error: null }),
    connectCheckpointFn: async ({ job_id }) => {
      connected.push(job_id);
      return { projection: { status: 'SKIPPED' }, delivery: null };
    },
    closeCheckpointTransportFn: async () => false,
    waitForInboxFn: async () => {
      waits += 1;
      controller.abort();
      return 'aborted';
    },
  });
  assert.equal(summary.processed, 1);
  assert.deepEqual(connected, ['resident-001']);
  assert.equal(waits, 1);
  assert.equal(getJobStatus({ root, job_id: 'resident-001' }).result.state, 'COMPLETED');
  assert.equal(fs.existsSync(path.join(root, 'dispatcher.lock')), false);
});

test('startup recovery terminalizes active/no-result as AMBIGUOUS without rerunning the worker', async () => {
  const root = tempRoot('recover');
  submitJob({ root, job: job('resident-ambiguous', root) });
  claimNextJob({ root });
  const controller = new AbortController();
  let runnerCalls = 0;
  const connected = [];
  const summary = await serveDispatcher({
    root,
    checkpointStateRoot: path.join(root, 'checkpoint-state'),
    signal: controller.signal,
    runner: async () => {
      runnerCalls += 1;
      return { state: 'COMPLETED', summary: 'must not run', evidence_refs: [], error: null };
    },
    connectCheckpointFn: async ({ job_id }) => {
      connected.push(job_id);
      return { projection: { status: 'SKIPPED' }, delivery: null };
    },
    closeCheckpointTransportFn: async () => false,
    waitForInboxFn: async () => {
      controller.abort();
      return 'aborted';
    },
  });
  assert.deepEqual([...summary.recovered], ['resident-ambiguous']);
  assert.equal(runnerCalls, 0);
  assert.deepEqual(connected, ['resident-ambiguous']);
  assert.equal(getJobStatus({ root, job_id: 'resident-ambiguous' }).result.state, 'AMBIGUOUS');
  assert.equal(fs.existsSync(path.join(root, 'dispatcher.lock')), false);
});

test('graceful idle shutdown releases the owned dispatcher lock', async () => {
  const root = tempRoot('idle');
  const controller = new AbortController();
  let waits = 0;
  let transportCloses = 0;
  await serveDispatcher({
    root,
    checkpointStateRoot: path.join(root, 'checkpoint-state'),
    signal: controller.signal,
    runner: async () => { throw new Error('no job should run'); },
    closeCheckpointTransportFn: async () => {
      transportCloses += 1;
      return true;
    },
    waitForInboxFn: async () => {
      waits += 1;
      controller.abort();
      return 'aborted';
    },
  });
  assert.equal(waits, 1);
  assert.equal(transportCloses, 1);
  assert.equal(fs.existsSync(path.join(root, 'dispatcher.lock')), false);
});
