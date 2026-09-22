#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  acquireDispatcherLock,
  dispatchNextJob,
  getJobStatus,
  recoverInterruptedJobs,
  releaseDispatcherLock,
  submitJob,
} from './ws-dispatch-core.mjs';
import { runOpenCodeWorker } from './ws-dispatch-opencode.mjs';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command) throw new Error('command is required: submit | status | run-once');
  const values = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    if (Object.prototype.hasOwnProperty.call(values, key)) throw new Error(`duplicate option: --${key}`);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) values[key] = true;
    else { values[key] = next; i += 1; }
  }
  return { command, values };
}

function required(values, key) {
  const value = values[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`--${key} is required`);
  return value;
}

async function readAll(stream) {
  let out = '';
  for await (const chunk of stream) out += chunk.toString();
  return out;
}

async function loadJob(values, stdin) {
  const fromFile = values.job;
  const fromStdin = values.stdin === true;
  if ((typeof fromFile === 'string') === fromStdin) throw new Error('provide exactly one of --job <file> or --stdin');
  const raw = fromStdin ? await readAll(stdin) : fs.readFileSync(path.resolve(fromFile), 'utf8');
  const parsed = JSON.parse(raw);
  return parsed;
}

export async function runCli(
  argv,
  {
    submitJobFn = submitJob,
    getJobStatusFn = getJobStatus,
    recoverInterruptedJobsFn = recoverInterruptedJobs,
    acquireDispatcherLockFn = acquireDispatcherLock,
    releaseDispatcherLockFn = releaseDispatcherLock,
    dispatchNextJobFn = dispatchNextJob,
    runOpenCodeWorkerFn = runOpenCodeWorker,
  } = {},
  {
    stdin = process.stdin,
    stdout = process.stdout,
  } = {},
) {
  const { command, values } = parseArgs(argv);
  const root = path.resolve(required(values, 'root'));

  if (command === 'submit') {
    const job = await loadJob(values, stdin);
    const file = submitJobFn({ root, job });
    stdout.write(`${JSON.stringify({ operation: 'submit', job_id: job.job_id, file }, null, 2)}\n`);
    return 0;
  }

  if (command === 'status') {
    const job_id = required(values, 'job-id');
    const status = getJobStatusFn({ root, job_id });
    stdout.write(`${JSON.stringify({ operation: 'status', job_id, ...status }, null, 2)}\n`);
    return 0;
  }

  if (command === 'run-once') {
    const recovered = recoverInterruptedJobsFn({ root });
    const lock = acquireDispatcherLockFn({ root });
    try {
      const model = typeof values.model === 'string' ? values.model : undefined;
      const agent = typeof values.agent === 'string' ? values.agent : undefined;
      const attach = typeof values.attach === 'string' ? values.attach : null;
      const result = await dispatchNextJobFn({
        root,
        runner: ({ job, evidence_dir }) => runOpenCodeWorkerFn({ job, evidence_dir, model, agent, attach }),
      });
      stdout.write(`${JSON.stringify({ operation: 'run-once', recovered, result }, null, 2)}\n`);
      return 0;
    } finally {
      releaseDispatcherLockFn(lock);
    }
  }

  throw new Error(`unknown command: ${command}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  runCli(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`${JSON.stringify({ error: error?.message || String(error) })}\n`);
      process.exitCode = 1;
    },
  );
}
