import fs from 'node:fs';
import path from 'node:path';

export const WS_DISPATCH_JOB_PROTOCOL = 'ws-dispatch.job';
export const WS_DISPATCH_RESULT_PROTOCOL = 'ws-dispatch.result';
export const WS_DISPATCH_SCHEMA_VERSION = 1;
export const WS_DISPATCH_TERMINAL_STATES = Object.freeze(['COMPLETED', 'FAILED', 'AMBIGUOUS', 'REJECTED']);

const JOB_KEYS = new Set(['protocol','schema_version','job_id','workspace','lane','authority','goal','done','reply','created_at']);
const REPLY_KEYS = new Set(['mode','target_alias']);
const RESULT_KEYS = new Set(['protocol','schema_version','job_id','state','lane','started_at','finished_at','summary','evidence_refs','error']);
const JOB_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const LANES = new Set(['muse','codex-luna','auto']);
const AUTHORITIES = new Set(['read-only','workspace-write']);
const REPLY_MODES = new Set(['NONE','REPORT','CONSULT']);

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function assertExactKeys(value, allowed, label) {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
}
function text(value, label, { nullable = false, max = 8192 } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) throw new Error(`${label} must be an exact non-empty string`);
  if (Buffer.byteLength(value, 'utf8') > max) throw new Error(`${label} is too large`);
  return value;
}
function iso(value, label) { text(value, label, { max: 64 }); if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be ISO date-time`); return value; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

export function validateJob(input) {
  assertExactKeys(input, JOB_KEYS, 'job');
  if (input.protocol !== WS_DISPATCH_JOB_PROTOCOL || input.schema_version !== WS_DISPATCH_SCHEMA_VERSION) throw new Error('unsupported job protocol/schema');
  if (!JOB_ID_RE.test(input.job_id || '')) throw new Error('job_id is invalid');
  text(input.workspace, 'workspace', { max: 4096 });
  if (!LANES.has(input.lane)) throw new Error('lane is invalid');
  if (!AUTHORITIES.has(input.authority)) throw new Error('authority is invalid');
  text(input.goal, 'goal', { max: 16000 });
  text(input.done, 'done', { max: 12000 });
  assertExactKeys(input.reply, REPLY_KEYS, 'reply');
  if (!REPLY_MODES.has(input.reply.mode)) throw new Error('reply.mode is invalid');
  if (input.reply.target_alias !== null) text(input.reply.target_alias, 'reply.target_alias', { max: 256 });
  iso(input.created_at, 'created_at');
  return Object.freeze(clone(input));
}

export function validateResult(input, expectedJobId = null) {
  assertExactKeys(input, RESULT_KEYS, 'result');
  if (input.protocol !== WS_DISPATCH_RESULT_PROTOCOL || input.schema_version !== WS_DISPATCH_SCHEMA_VERSION) throw new Error('unsupported result protocol/schema');
  if (!JOB_ID_RE.test(input.job_id || '')) throw new Error('result.job_id is invalid');
  if (expectedJobId !== null && input.job_id !== expectedJobId) throw new Error('result.job_id mismatch');
  if (!WS_DISPATCH_TERMINAL_STATES.includes(input.state)) throw new Error('result.state is invalid');
  if (!LANES.has(input.lane)) throw new Error('result.lane is invalid');
  iso(input.started_at, 'started_at');
  iso(input.finished_at, 'finished_at');
  text(input.summary, 'summary', { max: 16000 });
  if (!Array.isArray(input.evidence_refs) || input.evidence_refs.length > 64) throw new Error('evidence_refs is invalid');
  for (const [i, ref] of input.evidence_refs.entries()) text(ref, `evidence_refs[${i}]`, { max: 2048 });
  if (input.error !== null) text(input.error, 'error', { max: 16000 });
  return Object.freeze(clone(input));
}

export function layout(root) {
  const base = path.resolve(root);
  return Object.freeze({
    root: base,
    inbox: path.join(base, 'inbox'),
    active: path.join(base, 'active'),
    results: path.join(base, 'results'),
    archive: path.join(base, 'archive'),
    evidence: path.join(base, 'evidence'),
  });
}

export function ensureLayout(root) {
  const dirs = layout(root);
  for (const dir of [dirs.root, dirs.inbox, dirs.active, dirs.results, dirs.archive, dirs.evidence]) fs.mkdirSync(dir, { recursive: true });
  return dirs;
}

function durableWriteNew(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.tmp-${path.basename(file)}-${process.pid}-${Date.now()}`);
  const fd = fs.openSync(temp, 'wx');
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  if (fs.existsSync(file)) { fs.rmSync(temp, { force: true }); throw new Error(`already exists: ${file}`); }
  fs.renameSync(temp, file);
}

export function submitJob({ root, job }) {
  const dirs = ensureLayout(root);
  const valid = validateJob(job);
  const finalPath = path.join(dirs.inbox, `${valid.job_id}.json`);
  if (fs.existsSync(finalPath) || fs.existsSync(path.join(dirs.active, `${valid.job_id}.json`)) || fs.existsSync(path.join(dirs.results, `${valid.job_id}.json`))) {
    throw new Error(`job_id already exists: ${valid.job_id}`);
  }
  durableWriteNew(finalPath, valid);
  return finalPath;
}

export function claimNextJob({ root }) {
  const dirs = ensureLayout(root);
  const candidates = fs.readdirSync(dirs.inbox).filter((x) => x.endsWith('.json') && !x.startsWith('.tmp-')).sort();
  for (const name of candidates) {
    const source = path.join(dirs.inbox, name);
    const target = path.join(dirs.active, name);
    try { fs.renameSync(source, target); }
    catch (error) { if (error?.code === 'ENOENT' || error?.code === 'EEXIST' || error?.code === 'EPERM') continue; throw error; }
    const job = validateJob(JSON.parse(fs.readFileSync(target, 'utf8')));
    return Object.freeze({ job, active_path: target });
  }
  return null;
}

export function writeResult({ root, result }) {
  const dirs = ensureLayout(root);
  const valid = validateResult(result);
  const active = path.join(dirs.active, `${valid.job_id}.json`);
  if (!fs.existsSync(active)) throw new Error(`active job missing: ${valid.job_id}`);
  const job = validateJob(JSON.parse(fs.readFileSync(active, 'utf8')));
  validateResult(valid, job.job_id);
  const resultPath = path.join(dirs.results, `${valid.job_id}.json`);
  durableWriteNew(resultPath, valid);
  const archived = path.join(dirs.archive, `${valid.job_id}.json`);
  try { fs.renameSync(active, archived); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  return resultPath;
}

export function recoverInterruptedJobs({ root, now = new Date().toISOString() } = {}) {
  const dirs = ensureLayout(root);
  const recovered = [];
  for (const name of fs.readdirSync(dirs.active).filter((x) => x.endsWith('.json')).sort()) {
    const job = validateJob(JSON.parse(fs.readFileSync(path.join(dirs.active, name), 'utf8')));
    const activePath = path.join(dirs.active, name);
    const resultPath = path.join(dirs.results, `${job.job_id}.json`);
    if (fs.existsSync(resultPath)) {
      const archived = path.join(dirs.archive, `${job.job_id}.json`);
      if (!fs.existsSync(archived)) fs.renameSync(activePath, archived);
      else fs.rmSync(activePath, { force: true });
      continue;
    }
    const result = {
      protocol: WS_DISPATCH_RESULT_PROTOCOL,
      schema_version: WS_DISPATCH_SCHEMA_VERSION,
      job_id: job.job_id,
      state: 'AMBIGUOUS',
      lane: job.lane,
      started_at: job.created_at,
      finished_at: now,
      summary: 'Dispatcher restarted with this job already active and no terminal receipt. The job was not requeued or rerun.',
      evidence_refs: [],
      error: 'Prior execution outcome is unknown; reconcile workspace/runtime state before any retry.',
    };
    durableWriteNew(resultPath, validateResult(result, job.job_id));
    const archived = path.join(dirs.archive, `${job.job_id}.json`);
    fs.renameSync(activePath, archived);
    recovered.push(job.job_id);
  }
  return Object.freeze(recovered);
}

export function getJobStatus({ root, job_id }) {
  if (!JOB_ID_RE.test(job_id || '')) throw new Error('job_id is invalid');
  const dirs = ensureLayout(root);
  const resultPath = path.join(dirs.results, `${job_id}.json`);
  if (fs.existsSync(resultPath)) return Object.freeze({ state: 'TERMINAL', result: validateResult(JSON.parse(fs.readFileSync(resultPath, 'utf8')), job_id) });
  if (fs.existsSync(path.join(dirs.active, `${job_id}.json`))) return Object.freeze({ state: 'ACTIVE', result: null });
  if (fs.existsSync(path.join(dirs.inbox, `${job_id}.json`))) return Object.freeze({ state: 'QUEUED', result: null });
  return Object.freeze({ state: 'NOT_FOUND', result: null });
}

export function buildOpenCodeRun({ job, model = 'opencode-go/muse-spark-1.3-contributor', agent = null, attach = null } = {}) {
  const valid = validateJob(job);
  if (valid.authority === 'read-only' && agent && agent !== 'plan') {
    throw new Error('read-only jobs require the OpenCode plan agent');
  }
  const args = ['run'];
  if (attach) args.push('--attach', attach);
  const selectedAgent = agent || (valid.authority === 'read-only' ? 'plan' : 'build');
  args.push('--dir', valid.workspace, '--model', model, '--agent', selectedAgent, '--format', 'json');
  const prompt = [
    `Goal: ${valid.goal}`,
    `Done: ${valid.done}`,
    `Authority: ${valid.authority}. Stay within the bound workspace and authority.`,
    'Inspect current repository/runtime truth, then proceed autonomously. Do not stop after an intermediate stage while Done remains unresolved unless blocked by authority or a concrete unreconciled ambiguity.',
    'Return a concise final summary with verification and evidence paths.',
  ].join('\n');
  args.push(prompt);
  return Object.freeze({ command: 'opencode', args: Object.freeze(args), cwd: valid.workspace });
}


export function defaultIsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

export function acquireDispatcherLock({ root, pid = process.pid, started_at = new Date().toISOString(), isPidAlive = defaultIsPidAlive } = {}) {
  const dirs = ensureLayout(root);
  const lockPath = path.join(dirs.root, 'dispatcher.lock');
  const payload = { protocol: 'ws-dispatch.lock', schema_version: 1, pid, started_at };
  const attempt = () => {
    const fd = fs.openSync(lockPath, 'wx');
    try { fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`, 'utf8'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    return Object.freeze({ path: lockPath, pid, started_at });
  };
  try { return attempt(); }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let prior = null;
    try { prior = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch {}
    if (prior && isPidAlive(prior.pid)) throw new Error(`dispatcher already active: pid ${prior.pid}`);
    fs.rmSync(lockPath, { force: true });
    return attempt();
  }
}

export function releaseDispatcherLock(lock) {
  if (!lock?.path || !Number.isInteger(lock.pid)) throw new Error('valid dispatcher lock is required');
  if (!fs.existsSync(lock.path)) return false;
  let current = null;
  try { current = JSON.parse(fs.readFileSync(lock.path, 'utf8')); } catch {}
  if (!current || current.pid !== lock.pid) throw new Error('dispatcher lock ownership changed');
  fs.rmSync(lock.path, { force: true });
  return true;
}

export async function dispatchNextJob({ root, runner, now = () => new Date().toISOString() } = {}) {
  if (typeof runner !== 'function') throw new Error('runner function is required');
  const claim = claimNextJob({ root });
  if (!claim) return null;
  const started_at = now();
  let outcome;
  try {
    outcome = await runner({ job: claim.job, evidence_dir: ensureLayout(root).evidence });
  } catch (error) {
    outcome = { state: 'FAILED', summary: 'Worker runner threw before a terminal success receipt.', evidence_refs: [], error: error?.stack || error?.message || String(error) };
  }
  const state = outcome?.state || 'COMPLETED';
  const result = {
    protocol: WS_DISPATCH_RESULT_PROTOCOL,
    schema_version: WS_DISPATCH_SCHEMA_VERSION,
    job_id: claim.job.job_id,
    state,
    lane: claim.job.lane,
    started_at,
    finished_at: now(),
    summary: outcome?.summary || `Worker finished with state ${state}.`,
    evidence_refs: Array.isArray(outcome?.evidence_refs) ? outcome.evidence_refs : [],
    error: outcome?.error ?? null,
  };
  writeResult({ root, result });
  return getJobStatus({ root, job_id: claim.job.job_id }).result;
}
