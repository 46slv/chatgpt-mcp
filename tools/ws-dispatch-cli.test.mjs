import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runCli } from './ws-dispatch-cli.mjs';
import {
  WS_DISPATCH_JOB_PROTOCOL,
  WS_DISPATCH_SCHEMA_VERSION,
  dispatchNextJob,
  getJobStatus,
  submitJob,
} from './ws-dispatch-core.mjs';

function tempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ws-dispatch-cli-${label}-`));
}
function job(job_id, workspace) {
  return {
    protocol: WS_DISPATCH_JOB_PROTOCOL,
    schema_version: WS_DISPATCH_SCHEMA_VERSION,
    job_id,
    workspace,
    lane: 'muse',
    authority: 'read-only',
    goal: 'Inspect the bounded fixture.',
    done: 'Return one terminal result.',
    reply: { mode: 'NONE', target_alias: null },
    created_at: new Date().toISOString(),
  };
}
function capture() {
  let text = '';
  return { stream: { write: (value) => { text += String(value); } }, json: () => JSON.parse(text) };
}

test('submit and status expose the durable queue without launching a worker', async () => {
  const root = tempRoot('submit');
  const jobFile = path.join(root, 'job.json');
  fs.writeFileSync(jobFile, JSON.stringify(job('job-submit', root), null, 2));
  const out1 = capture();
  await runCli(['submit', '--root', root, '--job', jobFile], {}, { stdout: out1.stream });
  assert.equal(out1.json().job_id, 'job-submit');

  const out2 = capture();
  await runCli(['status', '--root', root, '--job-id', 'job-submit'], {}, { stdout: out2.stream });
  assert.equal(out2.json().state, 'QUEUED');
});

test('run-once executes one queued job locally and emits a terminal result', async () => {
  const root = tempRoot('run');
  submitJob({ root, job: job('job-run', root) });
  const out = capture();
  let workerCalls = 0;
  await runCli(
    ['run-once', '--root', root],
    {
      dispatchNextJobFn: dispatchNextJob,
      getJobStatusFn: getJobStatus,
      runOpenCodeWorkerFn: async ({ job: claimed }) => {
        workerCalls += 1;
        assert.equal(claimed.job_id, 'job-run');
        return { state: 'COMPLETED', summary: 'fixture complete', evidence_refs: [], error: null };
      },
    },
    { stdout: out.stream },
  );
  assert.equal(workerCalls, 1);
  assert.equal(out.json().result.state, 'COMPLETED');
  assert.equal(getJobStatus({ root, job_id: 'job-run' }).state, 'TERMINAL');
});

test('CLI rejects ambiguous job input instead of guessing a source', async () => {
  const root = tempRoot('input');
  await assert.rejects(
    () => runCli(['submit', '--root', root, '--stdin', '--job', path.join(root, 'x.json')]),
    /exactly one/,
  );
});
