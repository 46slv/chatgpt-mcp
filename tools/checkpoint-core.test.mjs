import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  bindWorkspace, buildReportPacket, checkpointStatus, defaultStateRoot,
  dispatchCheckpoint, evaluateStopGuard, pendingCheckpoints, recordCodexSession,
  saveCheckpoint,
} from './checkpoint-core.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-core-'));
  const workspace = path.join(root, 'repo');
  const local = path.join(root, 'local');
  fs.mkdirSync(workspace, { recursive: true });
  const git = (args) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }).trim();
  git(['init']); git(['config', 'user.email', 'checkpoint@test.local']); git(['config', 'user.name', 'Checkpoint Test']);
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'a1\n'); git(['add', '.']); git(['commit', '-m', 'base']);
  const registryPath = path.join(root, 'targets.json');
  fs.writeFileSync(registryPath, JSON.stringify({ schema_version: 1, default_target: 'test', targets: { test: { transport: 'chatgpt-web', chat_url: 'https://chatgpt.com/c/checkpoint-test', conversation_id: 'checkpoint-test' } } }, null, 2));
  return { root, workspace, local, registryPath, git };
}

test('checkpoint journal is append-only and session/git state is captured', () => {
  const f = fixture();
  recordCodexSession({ workspace: f.workspace, session_id: 'thr-1', stateRoot: f.local });
  const binding = bindWorkspace({ workspace: f.workspace, mission_id: 'MISSION-1', goal: 'Ship checkpoint v1', stateRoot: f.local, registryPath: f.registryPath });
  assert.equal(binding.target.conversation_id, 'checkpoint-test');
  fs.writeFileSync(path.join(f.workspace, 'a.txt'), 'a2\n');
  const e1 = saveCheckpoint({ workspace: f.workspace, next: 'Run focused tests', approach: 'Run the checkpoint core tests and repair only material failures.', done_for_next: 'Focused tests pass.', stateRoot: f.local });
  assert.equal(e1.sequence, 1); assert.equal(e1.mode, 'REPORT'); assert.equal(e1.producer.session_id, 'thr-1'); assert.equal(e1.observed_state.dirty, true); assert.deepEqual(e1.observed_state.changed_paths, ['a.txt']);
  const e2 = saveCheckpoint({ workspace: f.workspace, next: 'Prepare host canary', approach: 'Freeze exact candidate and document host-only send checks.', mode: 'CONSULT', question: 'Do you see any material gap before the host canary?', stateRoot: f.local });
  assert.equal(e2.sequence, 2); assert.notEqual(e2.checkpoint_id, e1.checkpoint_id);
  const status = checkpointStatus({ workspace: f.workspace, stateRoot: f.local });
  assert.equal(status.latest.checkpoint_id, e2.checkpoint_id); assert.equal(status.pending.length, 2);
  assert.match(buildReportPacket(e2), new RegExp(e2.report_id));
  assert.doesNotMatch(buildReportPacket(e2), new RegExp(f.workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('delivery receipts dedupe and ambiguous claims prevent blind resend', async () => {
  const f = fixture();
  recordCodexSession({ workspace: f.workspace, session_id: 'thr-2', stateRoot: f.local });
  bindWorkspace({ workspace: f.workspace, mission_id: 'MISSION-2', stateRoot: f.local, registryPath: f.registryPath });
  const e = saveCheckpoint({ workspace: f.workspace, next: 'Continue', approach: 'Keep going.', stateRoot: f.local });
  let sends = 0;
  const first = await dispatchCheckpoint({ event: e, stateRoot: f.local, send: async () => { sends += 1; return { chat_id: 'checkpoint-test', response: 'ack' }; } });
  assert.equal(first.status, 'DELIVERED'); assert.equal(first.receipt.delivery_proof, 'USER_TURN_ACK'); assert.equal(sends, 1);
  const second = await dispatchCheckpoint({ event: e, stateRoot: f.local, send: async () => { sends += 1; return { chat_id: 'checkpoint-test', response: 'again' }; } });
  assert.equal(second.status, 'CACHED'); assert.equal(sends, 1); assert.equal(pendingCheckpoints({ workspace: f.workspace, stateRoot: f.local }).length, 0);
});

test('delivery uncertainty becomes terminal receipt and is not retried', async () => {
  const f = fixture();
  recordCodexSession({ workspace: f.workspace, session_id: 'thr-3', stateRoot: f.local });
  bindWorkspace({ workspace: f.workspace, mission_id: 'MISSION-3', stateRoot: f.local, registryPath: f.registryPath });
  const e = saveCheckpoint({ workspace: f.workspace, next: 'Continue', approach: 'Keep going.', stateRoot: f.local });
  let sends = 0;
  const first = await dispatchCheckpoint({ event: e, stateRoot: f.local, send: async () => { sends += 1; throw new Error('transport vanished after submit'); } });
  assert.equal(first.status, 'DELIVERY_UNKNOWN');
  const second = await dispatchCheckpoint({ event: e, stateRoot: f.local, send: async () => { sends += 1; return { chat_id: 'checkpoint-test' }; } });
  assert.equal(second.status, 'CACHED'); assert.equal(sends, 1);
});

test('stop guard enforces one checkpoint per active Codex session and CONSULT completion', async () => {
  const f = fixture();
  recordCodexSession({ workspace: f.workspace, session_id: 'thr-stop', stateRoot: f.local });
  bindWorkspace({ workspace: f.workspace, mission_id: 'MISSION-STOP', stateRoot: f.local, registryPath: f.registryPath });
  const before = evaluateStopGuard({ workspace: f.workspace, session_id: 'thr-stop', stateRoot: f.local });
  assert.equal(before.decision, 'block');
  const report = saveCheckpoint({ workspace: f.workspace, next: 'Next', approach: 'Proceed.', stateRoot: f.local });
  const queued = evaluateStopGuard({ workspace: f.workspace, session_id: 'thr-stop', stateRoot: f.local });
  assert.equal(queued.decision, 'block'); assert.match(queued.reason, /waiting for REPORT/);
  const repeated = evaluateStopGuard({ workspace: f.workspace, session_id: 'thr-stop', stop_hook_active: true, stateRoot: f.local });
  assert.equal(repeated.continue, true); assert.match(repeated.systemMessage, /PENDING/);
  await dispatchCheckpoint({ event: report, stateRoot: f.local, send: async () => ({ chat_id: 'checkpoint-test', response: '' }) });
  assert.deepEqual(evaluateStopGuard({ workspace: f.workspace, session_id: 'thr-stop', stateRoot: f.local }), { continue: true });

  const consult = saveCheckpoint({ workspace: f.workspace, next: 'Decide', approach: 'Ask once.', mode: 'CONSULT', question: 'Proceed?', stateRoot: f.local });
  const pending = evaluateStopGuard({ workspace: f.workspace, session_id: 'thr-stop', stateRoot: f.local });
  assert.equal(pending.decision, 'block');
  const consultResult = await dispatchCheckpoint({ event: consult, stateRoot: f.local, send: async () => ({ chat_id: 'checkpoint-test', response: 'CONTINUE' }) });
  assert.equal(consultResult.receipt.delivery_proof, 'ASSISTANT_REPLY_READBACK');
  assert.deepEqual(evaluateStopGuard({ workspace: f.workspace, session_id: 'thr-stop', stateRoot: f.local }), { continue: true });
});

test('binding target drift is fail closed and likely secrets are rejected', () => {
  const f = fixture();
  bindWorkspace({ workspace: f.workspace, mission_id: 'MISSION-A', stateRoot: f.local, registryPath: f.registryPath });
  assert.throws(() => bindWorkspace({ workspace: f.workspace, mission_id: 'MISSION-B', stateRoot: f.local, registryPath: f.registryPath }), /different checkpoint binding/);
  assert.throws(() => saveCheckpoint({ workspace: f.workspace, next: 'Use sk-abcdefghijklmnopqrstuvwxyz12345', approach: 'No.', stateRoot: f.local }), /credential\/secret/);
});
