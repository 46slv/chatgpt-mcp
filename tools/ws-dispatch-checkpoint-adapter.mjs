import fs from 'node:fs';
import path from 'node:path';

import {
  findBindingForWorkspace,
  saveCheckpoint,
} from './checkpoint-core.mjs';
import {
  getJobStatus,
  layout,
  validateJob,
  validateResult,
} from './ws-dispatch-core.mjs';

export const WS_CHECKPOINT_LINK_PROTOCOL = 'ws-dispatch.checkpoint-link';
export const WS_CHECKPOINT_LINK_SCHEMA_VERSION = 1;

const JOB_ID_RE = /^[A-Za-z0-9._-]{1,128}$/u;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function links(root) {
  const directory = path.join(layout(root).root, 'checkpoint-links');
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function linkPaths(root, jobId) {
  const directory = links(root);
  return {
    claim: path.join(directory, `${jobId}.claim.json`),
    receipt: path.join(directory, `${jobId}.json`),
  };
}

function durableWriteNew(file, value) {
  const temp = path.join(path.dirname(file), `.tmp-${path.basename(file)}-${process.pid}-${Date.now()}`);
  const handle = fs.openSync(temp, 'wx');
  try {
    fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  if (fs.existsSync(file)) {
    fs.rmSync(temp, { force: true });
    throw new Error(`already exists: ${file}`);
  }
  fs.renameSync(temp, file);
}

function terminalPair(root, jobId) {
  if (!JOB_ID_RE.test(jobId || '')) throw new Error('job_id is invalid');
  const status = getJobStatus({ root, job_id: jobId });
  if (status.state !== 'TERMINAL') throw new Error(`job is not terminal: ${jobId}`);
  const dirs = layout(root);
  const jobFile = path.join(dirs.archive, `${jobId}.json`);
  if (!fs.existsSync(jobFile)) throw new Error(`archived job missing: ${jobId}`);
  const job = validateJob(readJson(jobFile));
  const result = validateResult(status.result, job.job_id);
  if (job.lane !== result.lane) throw new Error('terminal result lane does not match job');
  return { job, result };
}

function boundedEvidence(jobId, refs) {
  if (refs.length > 31) throw new Error('terminal result has too many evidence refs for one checkpoint');
  const projected = [`ws-dispatch-result:${jobId}`];
  for (const ref of refs) {
    if (Buffer.byteLength(ref, 'utf8') > 1000) throw new Error('terminal result evidence ref is too large for one checkpoint');
    projected.push(ref);
  }
  return projected;
}

function semantic(job, result) {
  const terminal = `WS Dispatch job ${job.job_id} reached ${result.state} on ${result.lane}: ${result.summary}`;
  const completed = result.state === 'COMPLETED';
  return {
    next: completed
      ? `Verify and continue from terminal WS Dispatch job ${job.job_id}.`
      : `Reconcile terminal WS Dispatch job ${job.job_id} (${result.state}) before any retry or further mutation.`,
    approach: terminal.slice(0, 6000),
    done_for_next: completed
      ? `Job acceptance: ${job.done}`.slice(0, 3000)
      : 'Live workspace and runtime state are reconciled; no blind retry or alternate target is used.',
    question: job.reply.mode === 'CONSULT'
      ? `What bounded next step should EPHEMERA consider after WS Dispatch job ${job.job_id} ended ${result.state}?`
      : null,
  };
}

export function readWsDispatchCheckpointLink({ root, job_id } = {}) {
  if (!JOB_ID_RE.test(job_id || '')) throw new Error('job_id is invalid');
  const paths = linkPaths(root, job_id);
  if (fs.existsSync(paths.receipt)) return Object.freeze({ status: 'LINKED', link: readJson(paths.receipt) });
  if (fs.existsSync(paths.claim)) return Object.freeze({ status: 'IN_FLIGHT_AMBIGUOUS', claim: readJson(paths.claim) });
  return Object.freeze({ status: 'NOT_LINKED', link: null });
}

export function projectWsDispatchResultToCheckpoint({ root, job_id, stateRoot, now = () => new Date().toISOString() } = {}) {
  const { job, result } = terminalPair(root, job_id);
  if (job.reply.mode === 'NONE') {
    return Object.freeze({ status: 'SKIPPED', reason: 'reply mode is NONE', event: null, link: null });
  }
  const binding = findBindingForWorkspace(job.workspace, { stateRoot });
  if (!binding) throw new Error('checkpoint binding not found for WS Dispatch workspace');
  if (job.reply.target_alias !== null && job.reply.target_alias !== binding.target.target_id) {
    throw new Error('WS Dispatch reply target does not match the immutable workspace checkpoint binding');
  }
  const existing = readWsDispatchCheckpointLink({ root, job_id });
  if (existing.status === 'LINKED') return Object.freeze({ status: 'CACHED', event: null, link: existing.link });
  if (existing.status === 'IN_FLIGHT_AMBIGUOUS') return Object.freeze({ status: existing.status, event: null, claim: existing.claim });

  const paths = linkPaths(root, job_id);
  const timestamp = now();
  const claim = {
    protocol: 'ws-dispatch.checkpoint-link-claim',
    schema_version: 1,
    job_id: job.job_id,
    workspace: binding.workspace,
    mission_id: binding.mission_id,
    reply_mode: job.reply.mode,
    claimed_at: timestamp,
    pid: process.pid,
  };
  durableWriteNew(paths.claim, claim);

  const fields = semantic(job, result);
  const event = saveCheckpoint({
    workspace: job.workspace,
    next: fields.next,
    approach: fields.approach,
    done_for_next: fields.done_for_next,
    mode: job.reply.mode,
    question: fields.question,
    evidence_refs: boundedEvidence(job.job_id, result.evidence_refs),
    producer_kind: 'local-worker',
    producer_session_id: job.job_id,
    stateRoot,
    now: () => timestamp,
  });
  const link = {
    protocol: WS_CHECKPOINT_LINK_PROTOCOL,
    schema_version: WS_CHECKPOINT_LINK_SCHEMA_VERSION,
    job_id: job.job_id,
    result_state: result.state,
    mission_id: event.mission_id,
    checkpoint_id: event.checkpoint_id,
    report_id: event.report_id,
    reply_mode: event.mode,
    linked_at: timestamp,
  };
  durableWriteNew(paths.receipt, link);
  fs.rmSync(paths.claim, { force: true });
  return Object.freeze({ status: 'CREATED', event, link });
}
