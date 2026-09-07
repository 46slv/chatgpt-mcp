import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  inspectSideEffectFingerprint,
  runSideEffectWithFingerprintGuard,
} from "./devexec-side-effect-fingerprint-guard.mjs";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "devexec-side-effect-guard-")); }
function action(overrides = {}) {
  return {
    surface: "github",
    action_type: "update_ref",
    target: "46slv/example:refs/heads/candidate",
    immutable_input: "candidate:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    expected_precondition: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    prior_attempt_id: null,
    control_identity: "ledger:control-v1",
    distinct_reason: null,
    ...overrides,
  };
}
function harness(overrides = {}) {
  let calls = 0;
  return {
    calls: () => calls,
    readControlIdentity: async () => ({ identity: "ledger:control-v1", decision: "ALLOW" }),
    readPrecondition: async () => "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    execute: async () => { calls += 1; return { ok: true }; },
    readBack: async () => ({ state: "MATCH", identity: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
    ...overrides,
  };
}
async function run(root, actionValue = action(), overrides = {}) {
  const h = harness(overrides);
  const result = await runSideEffectWithFingerprintGuard({ stateDir: root, action: actionValue, ...h });
  return { result, h };
}

test("PASS records fingerprint before one action and binds post-write readback", async () => {
  const root = tmp();
  const { result, h } = await run(root);
  assert.equal(result.decision, "PASS");
  assert.equal(result.record.status, "SUCCEEDED");
  assert.equal(result.record.attempt_count, 1);
  assert.equal(result.record.side_effect_count, 1);
  assert.equal(h.calls(), 1);
  assert.equal(inspectSideEffectFingerprint({ stateDir: root, action: action() }).status, "SUCCEEDED");
});

test("stale control identity stops before action", async () => {
  const root = tmp();
  const { result, h } = await run(root, action(), { readControlIdentity: async () => ({ identity: "ledger:newer", decision: "ALLOW" }) });
  assert.equal(result.reason_code, "STALE_CONTROL");
  assert.equal(h.calls(), 0);
  assert.equal(result.record.side_effect_count, 0);
});

test("fingerprint record failure stops before action", async () => {
  const parent = tmp();
  const root = path.join(parent, "state-file");
  fs.writeFileSync(root, "not-a-directory", "utf8");
  const h = harness();
  await assert.rejects(
    () => runSideEffectWithFingerprintGuard({ stateDir: root, action: action(), ...h }),
  );
  assert.equal(h.calls(), 0);
});

test("completed equivalent action is a duplicate and is never called twice", async () => {
  const root = tmp();
  const first = await run(root);
  assert.equal(first.result.decision, "PASS");
  const secondHarness = harness();
  const second = await runSideEffectWithFingerprintGuard({ stateDir: root, action: action({ distinct_reason: "same immutable action" }), ...secondHarness });
  assert.equal(second.decision, "DUPLICATE");
  assert.equal(second.reason_code, "SIDE_EFFECT_ALREADY_SUCCEEDED");
  assert.equal(secondHarness.calls(), 0);
});

test("frozen control records STOP and makes no downstream call", async () => {
  const root = tmp();
  const { result, h } = await run(root, action(), { readControlIdentity: async () => ({ identity: "ledger:control-v1", decision: "FROZEN" }) });
  assert.equal(result.reason_code, "FROZEN");
  assert.equal(h.calls(), 0);
});

test("explicit control STOP makes no downstream call", async () => {
  const root = tmp();
  const { result, h } = await run(root, action(), { readControlIdentity: async () => ({ identity: "ledger:control-v1", decision: "STOP" }) });
  assert.equal(result.reason_code, "CONTROL_STOP");
  assert.equal(h.calls(), 0);
});

test("a prior proven failure is still retry-forbidden for the equivalent immutable action", async () => {
  const root = tmp();
  const first = await run(root, action(), { readBack: async () => ({ state: "ABSENT", identity: null }) });
  assert.equal(first.result.record.status, "FAILED");
  const h = harness();
  const second = await runSideEffectWithFingerprintGuard({ stateDir: root, action: action({ prior_attempt_id: first.result.record.fingerprint, distinct_reason: "retry" }), ...h });
  assert.equal(second.reason_code, "RETRY_FORBIDDEN");
  assert.equal(h.calls(), 0);
});

test("native precondition mismatch stops before action", async () => {
  const root = tmp();
  const { result, h } = await run(root, action(), { readPrecondition: async () => "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" });
  assert.equal(result.reason_code, "PRECONDITION_MISMATCH");
  assert.equal(h.calls(), 0);
});

test("action failure performs readback once and never auto-retries", async () => {
  const root = tmp();
  let readbacks = 0;
  const { result, h } = await run(root, action(), {
    execute: async () => { throw new Error("connector failed"); },
    readBack: async () => { readbacks += 1; return { state: "ABSENT", identity: null }; },
  });
  assert.equal(result.reason_code, "NO_EFFECT_PROVEN");
  assert.equal(result.record.attempt_count, 1);
  assert.equal(result.record.side_effect_count, 1);
  assert.equal(readbacks, 1);
  assert.equal(h.calls(), 0);
});

test("ambiguous action is readback-only and remains non-retryable when outcome is unknown", async () => {
  const root = tmp();
  let calls = 0;
  let readbacks = 0;
  const first = await runSideEffectWithFingerprintGuard({
    stateDir: root,
    action: action(),
    readControlIdentity: async () => ({ identity: "ledger:control-v1", decision: "ALLOW" }),
    readPrecondition: async () => action().expected_precondition,
    execute: async () => { calls += 1; throw new Error("timeout after send"); },
    readBack: async () => { readbacks += 1; return { state: "UNKNOWN", identity: null }; },
  });
  assert.equal(first.reason_code, "OUTCOME_UNKNOWN");
  assert.equal(calls, 1);
  assert.equal(readbacks, 1);
  const secondHarness = harness();
  const second = await runSideEffectWithFingerprintGuard({ stateDir: root, action: action({ distinct_reason: "do not replay timeout" }), ...secondHarness });
  assert.equal(second.reason_code, "AMBIGUOUS_PRIOR_ATTEMPT");
  assert.equal(secondHarness.calls(), 0);
});

test("post-write identity mismatch is STOP and never becomes PASS", async () => {
  const root = tmp();
  const { result, h } = await run(root, action(), { readBack: async () => ({ state: "MISMATCH", identity: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" }) });
  assert.equal(result.reason_code, "POSTCONDITION_MISMATCH");
  assert.equal(result.record.status, "AMBIGUOUS");
  assert.equal(h.calls(), 1);
});

test("ambiguous transport can converge to PASS only through authoritative matching readback", async () => {
  const root = tmp();
  let calls = 0;
  const result = await runSideEffectWithFingerprintGuard({
    stateDir: root,
    action: action(),
    readControlIdentity: async () => ({ identity: "ledger:control-v1", decision: "ALLOW" }),
    readPrecondition: async () => action().expected_precondition,
    execute: async () => { calls += 1; throw new Error("timeout after commit"); },
    readBack: async () => ({ state: "MATCH", identity: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
  });
  assert.equal(result.decision, "PASS");
  assert.equal(result.record.status, "SUCCEEDED");
  assert.match(result.record.diagnostic, /timeout after commit/);
  assert.equal(calls, 1);
});
