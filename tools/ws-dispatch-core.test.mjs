import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  WS_DISPATCH_JOB_PROTOCOL,
  WS_DISPATCH_RESULT_PROTOCOL,
  WS_DISPATCH_SCHEMA_VERSION,
  buildOpenCodeRun,
  claimNextJob,
  getJobStatus,
  recoverInterruptedJobs,
  submitJob,
  writeResult,
} from './ws-dispatch-core.mjs';

function tempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ws-dispatch-')); }
function job(overrides = {}) {
  return {
    protocol: WS_DISPATCH_JOB_PROTOCOL,
    schema_version: WS_DISPATCH_SCHEMA_VERSION,
    job_id: 'job-001',
    workspace: 'C:\\work\\repo',
    lane: 'muse',
    authority: 'workspace-write',
    goal: 'Fix the failing focused test.',
    done: 'The focused test passes and the change is summarized.',
    reply: { mode: 'REPORT', target_alias: 'current-operation' },
    created_at: '2026-09-21T00:00:00.000Z',
    ...overrides,
  };
}

test('submit is durable and duplicate job_id is rejected', () => {
  const root = tempRoot();
  submitJob({ root, job: job() });
  assert.equal(getJobStatus({ root, job_id: 'job-001' }).state, 'QUEUED');
  assert.throws(() => submitJob({ root, job: job() }), /already exists/);
});

test('claim moves exactly one queued job into ACTIVE', () => {
  const root = tempRoot();
  submitJob({ root, job: job({ job_id: 'job-002' }) });
  const claim = claimNextJob({ root });
  assert.equal(claim.job.job_id, 'job-002');
  assert.equal(getJobStatus({ root, job_id: 'job-002' }).state, 'ACTIVE');
  assert.equal(claimNextJob({ root }), null);
});

test('terminal result is write-once and correlated to active job', () => {
  const root = tempRoot();
  submitJob({ root, job: job({ job_id: 'job-003' }) });
  claimNextJob({ root });
  const result = {
    protocol: WS_DISPATCH_RESULT_PROTOCOL,
    schema_version: WS_DISPATCH_SCHEMA_VERSION,
    job_id: 'job-003',
    state: 'COMPLETED',
    lane: 'muse',
    started_at: '2026-09-21T00:00:01.000Z',
    finished_at: '2026-09-21T00:00:02.000Z',
    summary: 'PASS',
    evidence_refs: ['evidence/job-003.jsonl'],
    error: null,
  };
  writeResult({ root, result });
  assert.equal(getJobStatus({ root, job_id: 'job-003' }).result.state, 'COMPLETED');
  assert.equal(fs.existsSync(path.join(root, 'active', 'job-003.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'archive', 'job-003.json')), true);
  assert.throws(() => writeResult({ root, result }), /active job missing|already exists/);
});

test('restart recovery marks active/no-receipt jobs AMBIGUOUS and never requeues them', () => {
  const root = tempRoot();
  submitJob({ root, job: job({ job_id: 'job-004' }) });
  claimNextJob({ root });
  const recovered = recoverInterruptedJobs({ root, now: '2026-09-21T00:10:00.000Z' });
  assert.deepEqual([...recovered], ['job-004']);
  const status = getJobStatus({ root, job_id: 'job-004' });
  assert.equal(status.state, 'TERMINAL');
  assert.equal(status.result.state, 'AMBIGUOUS');
  assert.equal(fs.existsSync(path.join(root, 'active', 'job-004.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'archive', 'job-004.json')), true);
  assert.equal(claimNextJob({ root }), null);
  assert.deepEqual([...recoverInterruptedJobs({ root, now: '2026-09-21T00:11:00.000Z' })], []);
});

test('OpenCode command builder carries only bounded job contract', () => {
  const run = buildOpenCodeRun({ job: job(), attach: 'http://127.0.0.1:4096' });
  assert.equal(run.command, 'opencode');
  assert.deepEqual(run.args.slice(0, 5), ['run','--attach','http://127.0.0.1:4096','--dir','C:\\work\\repo']);
  assert.ok(run.args.includes('--format'));
  assert.match(run.args.at(-1), /Goal: Fix the failing focused test/);
  assert.match(run.args.at(-1), /Authority: workspace-write/);
});

test('unknown fields and unsafe authority expansion fail closed', () => {
  const root = tempRoot();
  assert.throws(() => submitJob({ root, job: { ...job(), authority: 'full-machine' } }), /authority is invalid/);
  assert.throws(() => submitJob({ root, job: { ...job(), surprise: true } }), /unknown field/);
});
