import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const CHECKPOINT_PROTOCOL = 'ephemera.checkpoint-event';
export const CHECKPOINT_SCHEMA_VERSION = 1;
export const RECEIPT_PROTOCOL = 'ephemera.checkpoint-report-receipt';
export const RECEIPT_SCHEMA_VERSION = 1;
export const BINDING_PROTOCOL = 'ephemera.checkpoint-binding';
export const BINDING_SCHEMA_VERSION = 1;

const MODES = new Set(['REPORT', 'CONSULT']);
const TERMINAL_DELIVERY = new Set(['DELIVERED', 'DELIVERY_UNKNOWN', 'REJECTED']);

export function defaultStateRoot(env = process.env) {
  const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'ChatGPTMCPProbe', 'checkpoint-autoreport-v1');
}

export function defaultTargetRegistryPath(env = process.env) {
  const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'DevExec', 'targets.json');
}

function safeMkdir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(file, text) {
  safeMkdir(path.dirname(file));
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(temp, 'wx');
  try {
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}

function exclusiveJson(file, value) {
  safeMkdir(path.dirname(file));
  const fd = fs.openSync(file, 'wx');
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
}

export function canonicalJson(value) {
  return JSON.stringify(sortObject(value));
}

function requiredText(value, name, max = 4096) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  const text = value.trim();
  if (text.length > max) throw new Error(`${name} exceeds ${max} characters`);
  if (text.includes('\0')) throw new Error(`${name} contains NUL`);
  return text;
}

function optionalText(value, name, max = 4096) {
  if (value === undefined || value === null || value === '') return null;
  return requiredText(String(value), name, max);
}

function likelySecret(text) {
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
    /\b(?:sk|pk)-[A-Za-z0-9_-]{20,}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}/i,
    /\b(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*\S{8,}/i,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

function assertNoLikelySecrets(fields) {
  for (const [name, value] of Object.entries(fields)) {
    if (value && likelySecret(String(value))) throw new Error(`${name} appears to contain a credential/secret`);
  }
}

function idHash(prefix, value) {
  return `${prefix}-${sha256(value).slice(0, 24)}`;
}

function normalizedWorkspace(workspace) {
  return path.resolve(requiredText(workspace, 'workspace', 8192));
}

function workspaceKey(workspace) {
  return sha256(normalizedWorkspace(workspace).toLowerCase()).slice(0, 32);
}

function missionKey(missionId) {
  return sha256(requiredText(missionId, 'mission_id', 256)).slice(0, 32);
}

function bindingFile(stateRoot, workspace) {
  return path.join(stateRoot, 'bindings', `${workspaceKey(workspace)}.json`);
}

function sessionFile(stateRoot, workspace) {
  return path.join(stateRoot, 'sessions', `${workspaceKey(workspace)}.json`);
}

function missionDir(stateRoot, missionId) {
  return path.join(stateRoot, 'missions', missionKey(missionId));
}

function checkpointsDir(stateRoot, missionId) {
  return path.join(missionDir(stateRoot, missionId), 'checkpoints');
}

function receiptsDir(stateRoot, missionId) {
  return path.join(missionDir(stateRoot, missionId), 'receipts');
}

function claimsDir(stateRoot, missionId) {
  return path.join(missionDir(stateRoot, missionId), 'claims');
}

function activeFile(stateRoot, missionId) {
  return path.join(missionDir(stateRoot, missionId), 'active-checkpoint.json');
}

function lockFile(stateRoot, missionId) {
  return path.join(missionDir(stateRoot, missionId), 'writer.lock');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function withMissionLock(stateRoot, missionId, fn) {
  safeMkdir(missionDir(stateRoot, missionId));
  const file = lockFile(stateRoot, missionId);
  let fd;
  try {
    fd = fs.openSync(file, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + '\n', 'utf8');
    fs.fsyncSync(fd);
  } catch (error) {
    const wrapped = new Error(`checkpoint mission writer is busy: ${missionId}`);
    wrapped.code = 'CHECKPOINT_WRITER_BUSY';
    throw wrapped;
  }
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(file); } catch {}
  }
}

export function parseChatGPTTargetUrl(value) {
  const text = requiredText(value, 'target_url', 4096);
  const match = /^https:\/\/chatgpt\.com\/(?:c\/([A-Za-z0-9-]+)|g\/([A-Za-z0-9-]+)\/c\/([A-Za-z0-9-]+))$/.exec(text);
  if (!match) throw new Error('target_url is not an exact supported ChatGPT conversation URL');
  const parsed = new URL(text);
  if (parsed.origin !== 'https://chatgpt.com' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) throw new Error('target_url is not canonical');
  return { chat_url: text, conversation_id: match[1] || match[3] };
}

export function resolveTarget({ target_alias = null, target_url = null, expected_conversation_id = null, registryPath = defaultTargetRegistryPath() } = {}) {
  if (target_url) {
    const parsed = parseChatGPTTargetUrl(target_url);
    if (expected_conversation_id && expected_conversation_id !== parsed.conversation_id) throw new Error('expected_conversation_id does not match target_url');
    return { target_id: target_alias || idHash('target', parsed.chat_url), ...parsed };
  }
  if (!fs.existsSync(registryPath)) throw new Error(`target registry not found: ${registryPath}`);
  const registry = readJson(registryPath);
  if (registry?.schema_version !== 1 || !registry.targets || typeof registry.targets !== 'object') throw new Error('target registry is invalid');
  const alias = target_alias || registry.default_target;
  if (!alias || typeof alias !== 'string') throw new Error('target_alias is required when registry has no default');
  const entry = registry.targets[alias];
  if (!entry || entry.transport !== 'chatgpt-web') throw new Error(`target alias is unavailable: ${alias}`);
  const parsed = parseChatGPTTargetUrl(entry.chat_url);
  if (entry.conversation_id && entry.conversation_id !== parsed.conversation_id) throw new Error(`target alias conversation mismatch: ${alias}`);
  return { target_id: alias, ...parsed };
}

export function recordCodexSession({ workspace, session_id, source = null, model = null, stateRoot = defaultStateRoot(), now = () => new Date().toISOString() } = {}) {
  const root = normalizedWorkspace(workspace);
  const session = {
    protocol: 'ephemera.codex-session-marker', schema_version: 1,
    workspace: root,
    session_id: requiredText(session_id, 'session_id', 512),
    source: optionalText(source, 'source', 128),
    model: optionalText(model, 'model', 256),
    observed_at: now(),
  };
  atomicWrite(sessionFile(stateRoot, root), JSON.stringify(session, null, 2) + '\n');
  return session;
}

export function bindWorkspace({ workspace, mission_id, goal = null, target_alias = null, target_url = null, expected_conversation_id = null, replace = false, stateRoot = defaultStateRoot(), registryPath = defaultTargetRegistryPath(), now = () => new Date().toISOString() } = {}) {
  const root = normalizedWorkspace(workspace);
  const missionId = requiredText(mission_id, 'mission_id', 256);
  const target = resolveTarget({ target_alias, target_url, expected_conversation_id, registryPath });
  const file = bindingFile(stateRoot, root);
  if (fs.existsSync(file)) {
    const existing = readJson(file);
    const same = existing.mission_id === missionId && existing.target?.chat_url === target.chat_url && existing.target?.conversation_id === target.conversation_id;
    if (!same && !replace) throw new Error('workspace already has a different checkpoint binding; explicit replace is required');
    if (same) return existing;
  }
  const markerFile = sessionFile(stateRoot, root);
  const marker = fs.existsSync(markerFile) ? readJson(markerFile) : null;
  const binding = {
    protocol: BINDING_PROTOCOL, schema_version: BINDING_SCHEMA_VERSION,
    workspace: root,
    mission_id: missionId,
    goal: optionalText(goal, 'goal', 4000),
    target,
    bound_session_id: marker?.session_id || null,
    created_at: now(),
  };
  atomicWrite(file, JSON.stringify(binding, null, 2) + '\n');
  return binding;
}

export function findBindingForWorkspace(workspace, { stateRoot = defaultStateRoot() } = {}) {
  let current = normalizedWorkspace(workspace);
  for (;;) {
    const file = bindingFile(stateRoot, current);
    if (fs.existsSync(file)) return readJson(file);
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function git(root, args, fallback = null) {
  try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).trim(); }
  catch { return fallback; }
}

export function collectGitObservedState(workspace) {
  const root = normalizedWorkspace(workspace);
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (!top) return { kind: 'workspace', repo_name: path.basename(root), git: null };
  const head = git(top, ['rev-parse', 'HEAD']);
  const branch = git(top, ['branch', '--show-current'], '');
  let porcelain = '';
  try { porcelain = execFileSync('git', ['-C', top, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8', windowsHide: true }).trimEnd(); } catch { porcelain = ''; }
  const changed = porcelain ? porcelain.split(/\r?\n/).filter(Boolean).slice(0, 128).map((line) => line.slice(3).replaceAll('\\', '/')) : [];
  return {
    kind: 'git', repo_name: path.basename(top),
    head, branch: branch || null,
    dirty: Boolean(porcelain), changed_paths: changed,
  };
}

function eventFiles(stateRoot, missionId) {
  const dir = checkpointsDir(stateRoot, missionId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => /^\d{6}-[a-f0-9]{64}\.json$/.test(name)).sort();
}

function nextSequence(stateRoot, missionId) {
  const files = eventFiles(stateRoot, missionId);
  if (!files.length) return 1;
  return Number.parseInt(files.at(-1).slice(0, 6), 10) + 1;
}

function checkpointPath(stateRoot, missionId, sequence, checkpointId) {
  return path.join(checkpointsDir(stateRoot, missionId), `${String(sequence).padStart(6, '0')}-${checkpointId}.json`);
}

export function loadCheckpoint(stateRoot, missionId, checkpointId) {
  for (const name of eventFiles(stateRoot, missionId)) {
    if (name.endsWith(`-${checkpointId}.json`)) return readJson(path.join(checkpointsDir(stateRoot, missionId), name));
  }
  return null;
}

export function latestCheckpoint(stateRoot, missionId) {
  const files = eventFiles(stateRoot, missionId);
  if (!files.length) return null;
  return readJson(path.join(checkpointsDir(stateRoot, missionId), files.at(-1)));
}

export function saveCheckpoint({ workspace, next, approach, done_for_next = null, mode = 'REPORT', question = null, evidence_refs = [], producer_kind = 'codex', producer_session_id = undefined, stateRoot = defaultStateRoot(), now = () => new Date().toISOString() } = {}) {
  const root = normalizedWorkspace(workspace);
  const binding = findBindingForWorkspace(root, { stateRoot });
  if (!binding) throw new Error('checkpoint binding not found for workspace; call checkpoint_bind first');
  const normalizedMode = requiredText(mode, 'mode', 32).toUpperCase();
  if (!MODES.has(normalizedMode)) throw new Error('mode must be REPORT or CONSULT');
  const semantic = {
    next: requiredText(next, 'next', 4000),
    approach: requiredText(approach, 'approach', 6000),
    done_for_next: optionalText(done_for_next, 'done_for_next', 3000),
    question: optionalText(question, 'question', 4000),
  };
  if (normalizedMode === 'CONSULT' && !semantic.question) throw new Error('question is required for CONSULT mode');
  const producerKind = requiredText(producer_kind, 'producer_kind', 32);
  if (!new Set(['codex', 'ephemera', 'local-worker']).has(producerKind)) throw new Error('producer_kind is invalid');
  const producerSessionId = producer_session_id === undefined
    ? undefined
    : optionalText(producer_session_id, 'producer_session_id', 256);
  assertNoLikelySecrets(semantic);
  const refs = Array.isArray(evidence_refs) ? evidence_refs.slice(0, 32).map((x) => requiredText(String(x), 'evidence_ref', 1000)) : [];
  const markerFile = sessionFile(stateRoot, binding.workspace);
  const marker = fs.existsSync(markerFile) ? readJson(markerFile) : null;
  return withMissionLock(stateRoot, binding.mission_id, () => {
    const sequence = nextSequence(stateRoot, binding.mission_id);
    const base = {
      protocol: CHECKPOINT_PROTOCOL,
      schema_version: CHECKPOINT_SCHEMA_VERSION,
      mission_id: binding.mission_id,
      sequence,
      created_at: now(),
      producer: {
        kind: producerKind,
        session_id: producerSessionId === undefined
          ? (marker?.session_id || binding.bound_session_id || null)
          : producerSessionId,
      },
      workspace: binding.workspace,
      goal: binding.goal,
      mode: normalizedMode,
      semantic,
      observed_state: collectGitObservedState(binding.workspace),
      evidence_refs: refs,
      report_target: binding.target,
    };
    const checkpointId = sha256(canonicalJson(base));
    const event = { ...base, checkpoint_id: checkpointId, report_id: idHash('report', `${binding.mission_id}\n${checkpointId}\n${binding.target.conversation_id}`) };
    const file = checkpointPath(stateRoot, binding.mission_id, sequence, checkpointId);
    exclusiveJson(file, event);
    atomicWrite(activeFile(stateRoot, binding.mission_id), JSON.stringify({ mission_id: binding.mission_id, checkpoint_id: checkpointId, sequence, file }, null, 2) + '\n');
    return event;
  });
}

export function buildReportPacket(event) {
  const gitState = event.observed_state?.git === undefined ? event.observed_state : event.observed_state;
  const changed = Array.isArray(event.observed_state?.changed_paths) ? event.observed_state.changed_paths.slice(0, 32) : [];
  const lines = [
    `[CHECKPOINT_REPORT][${event.report_id}]`,
    `MISSION: ${event.mission_id}`,
    `CHECKPOINT: ${event.sequence} / ${event.checkpoint_id}`,
    `MODE: ${event.mode}`,
    event.goal ? `GOAL: ${event.goal}` : null,
    `NEXT: ${event.semantic.next}`,
    `APPROACH: ${event.semantic.approach}`,
    event.semantic.done_for_next ? `DONE_FOR_NEXT: ${event.semantic.done_for_next}` : null,
    event.observed_state?.repo_name ? `REPO: ${event.observed_state.repo_name}` : null,
    event.observed_state?.head ? `HEAD: ${event.observed_state.head}` : null,
    event.observed_state?.branch ? `BRANCH: ${event.observed_state.branch}` : null,
    event.observed_state?.dirty !== undefined ? `DIRTY: ${event.observed_state.dirty}` : null,
    changed.length ? `CHANGED: ${changed.join(', ')}` : null,
    event.evidence_refs?.length ? `EVIDENCE: ${event.evidence_refs.join(' | ')}` : null,
    event.mode === 'CONSULT' ? `QUESTION: ${event.semantic.question}` : 'NOTE: autonomous progress report; no execution authority is transferred to ChatGPT.',
  ].filter(Boolean);
  return lines.join('\n');
}

function receiptFile(stateRoot, missionId, checkpointId) {
  return path.join(receiptsDir(stateRoot, missionId), `${checkpointId}.json`);
}

function claimFile(stateRoot, missionId, checkpointId) {
  return path.join(claimsDir(stateRoot, missionId), `${checkpointId}.json`);
}

export function getReceipt(stateRoot, missionId, checkpointId) {
  const file = receiptFile(stateRoot, missionId, checkpointId);
  return fs.existsSync(file) ? readJson(file) : null;
}

export function getClaim(stateRoot, missionId, checkpointId) {
  const file = claimFile(stateRoot, missionId, checkpointId);
  return fs.existsSync(file) ? readJson(file) : null;
}

function beginClaim(stateRoot, event, now) {
  const file = claimFile(stateRoot, event.mission_id, event.checkpoint_id);
  const existingReceipt = getReceipt(stateRoot, event.mission_id, event.checkpoint_id);
  if (existingReceipt && TERMINAL_DELIVERY.has(existingReceipt.delivery_state)) return { status: 'TERMINAL', receipt: existingReceipt };
  if (fs.existsSync(file)) return { status: 'CLAIM_EXISTS', claim: readJson(file) };
  const claim = { protocol: 'ephemera.checkpoint-report-claim', schema_version: 1, mission_id: event.mission_id, checkpoint_id: event.checkpoint_id, report_id: event.report_id, pid: process.pid, claimed_at: now() };
  exclusiveJson(file, claim);
  return { status: 'CLAIMED', claim, file };
}

function finishReceipt(stateRoot, event, receipt, claimPath) {
  const file = receiptFile(stateRoot, event.mission_id, event.checkpoint_id);
  if (fs.existsSync(file)) return readJson(file);
  exclusiveJson(file, receipt);
  try { if (claimPath) fs.unlinkSync(claimPath); } catch {}
  return receipt;
}

export async function dispatchCheckpoint({ event, send, stateRoot = defaultStateRoot(), now = () => new Date().toISOString() } = {}) {
  if (!event || event.protocol !== CHECKPOINT_PROTOCOL) throw new Error('valid checkpoint event required');
  if (typeof send !== 'function') throw new Error('send adapter required');
  const claim = beginClaim(stateRoot, event, now);
  if (claim.status === 'TERMINAL') return { status: 'CACHED', receipt: claim.receipt };
  if (claim.status === 'CLAIM_EXISTS') return { status: 'IN_FLIGHT_AMBIGUOUS', claim: claim.claim };
  const packet = buildReportPacket(event);
  let result;
  let deliveryState = 'DELIVERED';
  let error = null;
  try {
    result = await send({ packet, event, target: event.report_target });
    if (!result || result.error) {
      deliveryState = 'DELIVERY_UNKNOWN';
      error = String(result?.error || 'send adapter returned no result');
    } else if (result.chat_id && result.chat_id !== event.report_target.conversation_id) {
      deliveryState = 'REJECTED';
      error = 'response conversation identity mismatch';
    }
  } catch (err) {
    deliveryState = 'DELIVERY_UNKNOWN';
    error = String(err?.message || err);
  }
  const receipt = {
    protocol: RECEIPT_PROTOCOL,
    schema_version: RECEIPT_SCHEMA_VERSION,
    mission_id: event.mission_id,
    checkpoint_id: event.checkpoint_id,
    report_id: event.report_id,
    mode: event.mode,
    delivery_state: deliveryState,
    delivery_proof: deliveryState === 'DELIVERED'
      ? (event.mode === 'REPORT' ? 'USER_TURN_ACK' : 'ASSISTANT_REPLY_READBACK')
      : null,
    target: event.report_target,
    delivered_at: now(),
    response_sha256: result?.response ? sha256(String(result.response)) : null,
    response_preview: event.mode === 'CONSULT' && result?.response ? String(result.response).slice(0, 2000) : null,
    error,
  };
  const stored = finishReceipt(stateRoot, event, receipt, claim.file);
  return { status: stored.delivery_state, receipt: stored, response: event.mode === 'CONSULT' ? (result?.response || null) : null };
}

export function pendingCheckpoints({ workspace = null, mission_id = null, stateRoot = defaultStateRoot() } = {}) {
  const binding = workspace ? findBindingForWorkspace(workspace, { stateRoot }) : null;
  const missionId = mission_id || binding?.mission_id;
  if (!missionId) return [];
  return eventFiles(stateRoot, missionId).map((name) => readJson(path.join(checkpointsDir(stateRoot, missionId), name))).filter((event) => !getReceipt(stateRoot, missionId, event.checkpoint_id));
}

export function checkpointStatus({ workspace, stateRoot = defaultStateRoot() } = {}) {
  const binding = findBindingForWorkspace(workspace, { stateRoot });
  if (!binding) return { active: false, binding: null, latest: null, pending: [] };
  const latest = latestCheckpoint(stateRoot, binding.mission_id);
  const pending = pendingCheckpoints({ mission_id: binding.mission_id, stateRoot }).map((event) => ({ checkpoint_id: event.checkpoint_id, sequence: event.sequence, mode: event.mode, claim: getClaim(stateRoot, event.mission_id, event.checkpoint_id) }));
  const receipt = latest ? getReceipt(stateRoot, binding.mission_id, latest.checkpoint_id) : null;
  return { active: true, binding, latest, latest_receipt: receipt, pending };
}

export function evaluateStopGuard({ workspace, session_id, stop_hook_active = false, stateRoot = defaultStateRoot() } = {}) {
  const status = checkpointStatus({ workspace, stateRoot });
  if (!status.active) return { continue: true };
  const currentSession = requiredText(session_id, 'session_id', 512);
  const latest = status.latest;
  if (!latest || latest.producer?.session_id !== currentSession) {
    if (stop_hook_active) return { continue: true, systemMessage: 'Checkpoint autoreport is active, but no checkpoint was recorded for this Codex session.' };
    return { decision: 'block', reason: 'Checkpoint autoreport is active for this workspace. Save one material checkpoint with checkpoint_save before ending this turn.' };
  }
  if (latest.mode === 'CONSULT' && status.latest_receipt?.delivery_state !== 'DELIVERED') {
    if (stop_hook_active) return { continue: true, systemMessage: 'Required CONSULT checkpoint is not confirmed delivered; manual reconciliation may be required.' };
    return { decision: 'block', reason: 'The latest checkpoint requires CONSULT, but its ChatGPT delivery/readback is not confirmed. Inspect checkpoint_status and resolve it before stopping.' };
  }
  if (latest.mode === 'REPORT' && status.latest_receipt?.delivery_state !== 'DELIVERED') {
    const delivery = status.latest_receipt?.delivery_state
      || (status.pending?.find((item) => item.checkpoint_id === latest.checkpoint_id)?.claim ? 'IN_FLIGHT_AMBIGUOUS' : 'PENDING');
    if (stop_hook_active) {
      return {
        continue: true,
        systemMessage: `Checkpoint ${latest.sequence} REPORT remains ${delivery}. State is durable; do not blind-resend an ambiguous report.`,
      };
    }
    return {
      decision: 'block',
      reason: `Checkpoint autoreport is waiting for REPORT ${latest.sequence} delivery confirmation (${delivery}). Inspect checkpoint_status once; if DELIVERED, stop again. If the state is ambiguous/unknown, do not resend blindly; a second stop attempt may leave the durable unresolved state for later reconciliation.`,
    };
  }
  return { continue: true };
}
