import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runOnce, runStatus, resolveRelayTarget } from "./devexec-relay.mjs";
import { FIXED_CHAT_URL, FIXED_CONVERSATION_ID, sha256Digest } from "./devexec-roundtrip-relay.mjs";

const THREAD_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const THREAD_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WORK = "D:\\Documents\\Codex\\relay-task";
const ALIAS = "devexec-relay";
const REPORT = "Daily relay operational check. Thread healthy, no repository changes required.";
const EXPECT = "DAILY-RELAY-OK rt-test";

function fakeResolver() {
  return ({ explicitTarget }) => {
    assert.equal(explicitTarget, ALIAS);
    return { target_id: ALIAS, chat_url: FIXED_CHAT_URL, conversation_id: FIXED_CONVERSATION_ID, source: "explicit" };
  };
}

function continueEnvelope(report, requestId) {
  return JSON.stringify({
    protocol: "devexec.codex-prompt",
    schema_version: 1,
    mission_id: "task-mission",
    task_id: "task-daily",
    relay_request_id: requestId,
    report_sha256: sha256Digest(report),
    decision: "CONTINUE",
    prompt: `Reply with exactly: ${EXPECT}`,
  });
}

function fakeTransportFactory(seen) {
  return async ({ payload, chat_url, conversation_id }) => {
    seen.calls += 1;
    seen.payload = payload;
    assert.equal(chat_url, FIXED_CHAT_URL);
    assert.equal(conversation_id, FIXED_CONVERSATION_ID);
    return { response: seen.envelope, chat_id: FIXED_CONVERSATION_ID, model: "fixture", elapsed_seconds: 1, poll_count: 1 };
  };
}

function fakeInvokeFactory(seen, threadId, proveThreadId) {
  return async (invocation) => {
    seen.calls += 1;
    assert.deepEqual(invocation.args.slice(0, 4), ["exec", "resume", "--json", threadId]);
    assert.equal(invocation.args.includes("--last"), false);
    const proved = proveThreadId === undefined ? threadId : proveThreadId;
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: proved }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: `Reply with exactly: ${EXPECT}` } }),
    ];
    return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
  };
}

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-once-"));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function exeFixture(dir) {
  const exe = path.join(dir, "codex-test.exe");
  const impl = path.join(dir, "codex-test.js");
  fs.writeFileSync(exe, "exe-fixture\\n", "utf8");
  fs.writeFileSync(impl, "impl-fixture\\n", "utf8");
  return { codex_exe: exe, codex_impl: [impl] };
}

function baseOptions(dir, overrides = {}) {
  return {
    thread: THREAD_A, target: ALIAS, report: REPORT,
    mission: "task-mission", task: "task-daily", nonce: "n123",
    request_id: "req-1", cwd: WORK, repo: WORK,
    expect: EXPECT, state_dir: path.join(dir, "state"),
    targetResolver: fakeResolver(), ...overrides,
  };
}

test("once happy path relays report and returns to the same thread", async () => {
  const dir = tmpDir();
  const exe = exeFixture(dir);
  const seenT = { calls: 0, envelope: continueEnvelope(REPORT, "req-1") };
  const seenI = { calls: 0 };
  const transport = fakeTransportFactory(seenT);
  const invoke = fakeInvokeFactory(seenI, THREAD_A);
  const first = await runOnce({ ...baseOptions(dir), ...exe, transport, invoke });
  assert.equal(first.same_thread, true);
  assert.equal(first.thread_after, THREAD_A);
  assert.equal(seenT.calls, 1);
  assert.equal(seenI.calls, 1);
  assert.match(seenT.payload, /Daily relay operational check/);
  const status = runStatus({ state_dir: path.join(dir, "state") });
  assert.equal(status.codex_returned, true);
  assert.equal(status.same_thread, true);
  // Rerun resumes from artifacts: no second send, no second injection.
  const second = await runOnce({ ...baseOptions(dir), ...exe, transport, invoke });
  assert.equal(second.same_thread, true);
  assert.equal(seenT.calls, 1);
  assert.equal(seenI.calls, 1);
});

test("resume proof for a different thread fails closed with no return record", async () => {
  const dir = tmpDir();
  const exe = exeFixture(dir);
  const seenT = { calls: 0, envelope: continueEnvelope(REPORT, "req-1") };
  const transport = fakeTransportFactory(seenT);
  const invoke = fakeInvokeFactory({ calls: 0 }, THREAD_A, THREAD_B);
  await assert.rejects(
    () => runOnce({ ...baseOptions(dir), ...exe, transport, invoke }),
    (error) => /different thread|exact bound thread|uncertain/.test(error.message),
  );
  const status = runStatus({ state_dir: path.join(dir, "state") });
  assert.equal(status.codex_returned, false);
  assert.equal(status.chatgpt_response, true);
});

test("envelope with wrong relay id is rejected before any Codex invocation", async () => {
  const dir = tmpDir();
  const exe = exeFixture(dir);
  const seenT = { calls: 0, envelope: continueEnvelope(REPORT, "req-1") };
  const seenI = { calls: 0 };
  const transport = async (input) => {
    seenT.calls += 1;
    const bad = JSON.parse(continueEnvelope(REPORT, "other-request"));
    return { response: JSON.stringify(bad), chat_id: FIXED_CONVERSATION_ID, model: "fixture", elapsed_seconds: 1, poll_count: 1 };
  };
  await assert.rejects(
    () => runOnce({ ...baseOptions(dir), transport, invoke: fakeInvokeFactory(seenI, THREAD_A) }),
    (error) => /correlation|relay_request_id|CONTINUE envelope rejected/.test(error.message),
  );
  assert.equal(seenI.calls, 0);
});

test("target drift on rerun refuses to cross-route", async () => {
  const dir = tmpDir();
  const exe = exeFixture(dir);
  const seenT = { calls: 0, envelope: continueEnvelope(REPORT, "req-1") };
  const transport = fakeTransportFactory(seenT);
  const invoke = fakeInvokeFactory({ calls: 0 }, THREAD_A);
  await runOnce({ ...baseOptions(dir), ...exe, transport, invoke });
  const drifted = () => ({
    target_id: ALIAS, chat_url: "https://chatgpt.com/c/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    conversation_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", source: "explicit",
  });
  await assert.rejects(
    () => runOnce({ ...baseOptions(dir), transport, invoke, targetResolver: drifted }),
    (error) => /drifted/.test(error.message),
  );
  assert.equal(seenT.calls, 1);
});

test("resolveRelayTarget requires an explicit alias (no silent default)", () => {
  assert.throws(() => resolveRelayTarget(""), /Missing --target/);
  assert.throws(() => resolveRelayTarget(null), /Missing --target/);
});
