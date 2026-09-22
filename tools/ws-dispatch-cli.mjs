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
import {
  closeWsDispatchCheckpointTransport,
  connectTerminalResultToCheckpoint,
} from './ws-dispatch-checkpoint-delivery.mjs';
import { resolveWsDispatchConfig } from './ws-dispatch-config.mjs';
import {
  installScheduledDispatcher,
  readWsDispatchInstallation,
  scheduledTaskStatus,
  uninstallScheduledDispatcher,
} from './ws-dispatch-install.mjs';
import { runOpenCodeWorker } from './ws-dispatch-opencode.mjs';
import { appendDispatcherLog, serveDispatcher } from './ws-dispatch-server.mjs';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command) throw new Error('command is required: submit | status | run-once | serve | task-install | task-status | task-uninstall');
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

function positiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  if (!/^\d+$/u.test(String(value)) || Number(value) < 1) throw new Error('wait-ms must be a positive integer');
  return Number(value);
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
  return JSON.parse(raw);
}

function workerRunner(values, runOpenCodeWorkerFn) {
  const model = typeof values.model === 'string' ? values.model : undefined;
  const agent = typeof values.agent === 'string' ? values.agent : undefined;
  const attach = typeof values.attach === 'string' ? values.attach : null;
  return async ({ job, evidence_dir }) => {
    if (job.lane !== 'muse') {
      return {
        state: 'REJECTED',
        summary: `Worker lane ${job.lane} is reserved and is not qualified in WS Dispatch v1.`,
        evidence_refs: [],
        error: 'Only lane=muse is executable in WS Dispatch v1.',
      };
    }
    return runOpenCodeWorkerFn({
      job,
      evidence_dir,
      model,
      agent: job.authority === 'read-only' ? 'plan' : agent,
      attach,
    });
  };
}

async function connectCheckpointSafely(connectCheckpointFn, args) {
  try {
    return { checkpoint: await connectCheckpointFn(args), checkpoint_error: null };
  } catch (error) {
    return { checkpoint: null, checkpoint_error: error?.stack || error?.message || String(error) };
  }
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
    connectCheckpointFn = connectTerminalResultToCheckpoint,
    closeCheckpointTransportFn = closeWsDispatchCheckpointTransport,
    serveDispatcherFn = serveDispatcher,
    installScheduledDispatcherFn = installScheduledDispatcher,
    scheduledTaskStatusFn = scheduledTaskStatus,
    uninstallScheduledDispatcherFn = uninstallScheduledDispatcher,
    readWsDispatchInstallationFn = readWsDispatchInstallation,
  } = {},
  {
    stdin = process.stdin,
    stdout = process.stdout,
    signal = null,
  } = {},
) {
  const { command, values } = parseArgs(argv);
  const config = resolveWsDispatchConfig({
    root: typeof values.root === 'string' ? values.root : null,
    checkpointStateRoot: typeof values['checkpoint-state-root'] === 'string' ? values['checkpoint-state-root'] : null,
  });

  if (command === 'submit') {
    const job = await loadJob(values, stdin);
    const file = submitJobFn({ root: config.root, job });
    stdout.write(`${JSON.stringify({ operation: 'submit', job_id: job.job_id, root: config.root, file }, null, 2)}\n`);
    return 0;
  }

  if (command === 'status') {
    const job_id = required(values, 'job-id');
    const status = getJobStatusFn({ root: config.root, job_id });
    stdout.write(`${JSON.stringify({ operation: 'status', job_id, root: config.root, ...status }, null, 2)}\n`);
    return 0;
  }

  if (command === 'run-once') {
    const lock = acquireDispatcherLockFn({ root: config.root });
    try {
      const recovered = recoverInterruptedJobsFn({ root: config.root });
      const recovered_checkpoints = [];
      for (const job_id of recovered) {
        recovered_checkpoints.push({
          job_id,
          ...await connectCheckpointSafely(connectCheckpointFn, { root: config.root, job_id, stateRoot: config.checkpoint_state_root }),
        });
      }
      const result = await dispatchNextJobFn({ root: config.root, runner: workerRunner(values, runOpenCodeWorkerFn) });
      const checkpoint = result
        ? await connectCheckpointSafely(connectCheckpointFn, { root: config.root, job_id: result.job_id, stateRoot: config.checkpoint_state_root })
        : { checkpoint: null, checkpoint_error: null };
      stdout.write(`${JSON.stringify({ operation: 'run-once', root: config.root, recovered, recovered_checkpoints, result, ...checkpoint }, null, 2)}\n`);
      return 0;
    } finally {
      releaseDispatcherLockFn(lock);
      await closeCheckpointTransportFn();
    }
  }

  if (command === 'serve') {
    const ownController = signal ? null : new AbortController();
    const activeSignal = signal || ownController.signal;
    const stop = () => ownController?.abort();
    if (ownController) {
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    }
    try {
      const summary = await serveDispatcherFn({
        root: config.root,
        checkpointStateRoot: config.checkpoint_state_root,
        runner: workerRunner(values, runOpenCodeWorkerFn),
        signal: activeSignal,
        waitMs: positiveInteger(values['wait-ms'], 1000),
        connectCheckpointFn,
        closeCheckpointTransportFn,
        recoverInterruptedJobsFn,
        acquireDispatcherLockFn,
        releaseDispatcherLockFn,
        dispatchNextJobFn,
        onEvent: (event) => appendDispatcherLog(config.log_file, event),
      });
      stdout.write(`${JSON.stringify({ operation: 'serve', root: config.root, summary }, null, 2)}\n`);
      return 0;
    } finally {
      if (ownController) {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
      }
    }
  }

  if (command === 'task-install') {
    const installed = installScheduledDispatcherFn({ config });
    stdout.write(`${JSON.stringify({ operation: 'task-install', root: config.root, ...installed }, null, 2)}\n`);
    return 0;
  }

  if (command === 'task-status') {
    const task = scheduledTaskStatusFn({ config });
    const installation = readWsDispatchInstallationFn({ config });
    stdout.write(`${JSON.stringify({ operation: 'task-status', root: config.root, task, installation }, null, 2)}\n`);
    return 0;
  }

  if (command === 'task-uninstall') {
    const removed = uninstallScheduledDispatcherFn({ config });
    stdout.write(`${JSON.stringify({ operation: 'task-uninstall', root: config.root, ...removed }, null, 2)}\n`);
    return 0;
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
