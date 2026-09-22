import fs from 'node:fs';
import path from 'node:path';

import {
  acquireDispatcherLock,
  dispatchNextJob,
  ensureLayout,
  recoverInterruptedJobs,
  releaseDispatcherLock,
} from './ws-dispatch-core.mjs';
import { connectTerminalResultToCheckpoint } from './ws-dispatch-checkpoint-delivery.mjs';

function terminalJobIds(root) {
  const dirs = ensureLayout(root);
  return fs.readdirSync(dirs.results)
    .filter((name) => name.endsWith('.json') && !name.startsWith('.tmp-'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
}

export function appendDispatcherLog(file, event) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
}

export async function waitForInbox({ root, timeoutMs = 1000, signal } = {}) {
  const dirs = ensureLayout(root);
  if (signal?.aborted) return 'aborted';
  const bounded = Math.max(100, Math.min(Number(timeoutMs) || 1000, 60000));
  return await new Promise((resolve) => {
    let watcher = null;
    let settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { watcher?.close(); } catch {}
      signal?.removeEventListener('abort', onAbort);
      resolve(reason);
    };
    const onAbort = () => finish('aborted');
    const timer = setTimeout(() => finish('timeout'), bounded);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      watcher = fs.watch(dirs.inbox, { persistent: false }, () => finish('change'));
      watcher.once('error', () => finish('watch-error'));
    } catch {
      // The bounded timer remains the fallback when filesystem watching is unavailable.
    }
  });
}

export async function serveDispatcher({
  root,
  checkpointStateRoot,
  runner,
  signal,
  waitMs = 1000,
  waitForInboxFn = waitForInbox,
  connectCheckpointFn = connectTerminalResultToCheckpoint,
  recoverInterruptedJobsFn = recoverInterruptedJobs,
  acquireDispatcherLockFn = acquireDispatcherLock,
  releaseDispatcherLockFn = releaseDispatcherLock,
  dispatchNextJobFn = dispatchNextJob,
  onEvent = () => {},
} = {}) {
  if (typeof runner !== 'function') throw new Error('runner function is required');
  const lock = acquireDispatcherLockFn({ root });
  const summary = { recovered: [], processed: 0, checkpoint_failures: 0, stopped: false };
  const emit = (type, detail = {}) => onEvent({ type, at: new Date().toISOString(), ...detail });

  const connect = async (jobId) => {
    try {
      const checkpoint = await connectCheckpointFn({ root, job_id: jobId, stateRoot: checkpointStateRoot });
      emit('CHECKPOINT_CONNECTED', {
        job_id: jobId,
        projection_status: checkpoint?.projection?.status || null,
        delivery_status: checkpoint?.delivery?.status || null,
      });
      return checkpoint;
    } catch (error) {
      summary.checkpoint_failures += 1;
      emit('CHECKPOINT_FAILED', { job_id: jobId, error: error?.stack || error?.message || String(error) });
      return null;
    }
  };

  try {
    emit('STARTING', { pid: process.pid, root });
    summary.recovered = [...recoverInterruptedJobsFn({ root })];
    for (const jobId of terminalJobIds(root)) await connect(jobId);
    emit('READY', { recovered: summary.recovered });

    while (!signal?.aborted) {
      const result = await dispatchNextJobFn({ root, runner });
      if (result) {
        summary.processed += 1;
        emit('JOB_TERMINAL', { job_id: result.job_id, state: result.state });
        await connect(result.job_id);
        continue;
      }
      await waitForInboxFn({ root, timeoutMs: waitMs, signal });
    }
    summary.stopped = true;
    return Object.freeze({ ...summary, recovered: Object.freeze([...summary.recovered]) });
  } finally {
    releaseDispatcherLockFn(lock);
    emit('STOPPED', { pid: process.pid });
  }
}
