import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import {
  deriveSideEffectFingerprint,
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


function runConcurrentWorker({ moduleUrl, stateDir, actionValue, shared }) {
  return new Promise((resolve, reject) => {
    const source = `
      const fs = require("node:fs");
      const { parentPort, workerData } = require("node:worker_threads");
      const shared = new Int32Array(workerData.shared);
      const originalOpenSync = fs.openSync.bind(fs);
      let fenced = false;
      fs.openSync = function(file, flags, ...args) {
        if (!fenced && flags === "wx" && (String(file).endsWith(".json") || String(file).endsWith(".claim"))) {
          fenced = true;
          const arrived = Atomics.add(shared, 0, 1) + 1;
          Atomics.notify(shared, 0);
          const deadline = Date.now() + 5000;
          while (Atomics.load(shared, 0) < 2) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new Error("equivalence race barrier timeout");
            Atomics.wait(shared, 0, Atomics.load(shared, 0), Math.min(remaining, 50));
          }
        }
        return originalOpenSync(file, flags, ...args);
      };
      (async () => {
        const mod = await import(workerData.moduleUrl);
        const result = await mod.runSideEffectWithFingerprintGuard({
          stateDir: workerData.stateDir,
          action: workerData.actionValue,
          readControlIdentity: async () => ({ identity: "ledger:control-v1", decision: "ALLOW" }),
          readPrecondition: async () => "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          execute: async () => {
            Atomics.add(shared, 1, 1);
            return { ok: true };
          },
          readBack: async () => ({ state: "MATCH", identity: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
        });
        parentPort.postMessage({ ok: true, decision: result.decision, reason_code: result.reason_code });
      })().catch((error) => {
        parentPort.postMessage({ ok: false, code: error.code || null, message: String(error.message || error) });
      });
    `;
    const worker = new Worker(source, {
      eval: true,
      workerData: { moduleUrl, stateDir, actionValue, shared },
    });
    let settled = false;
    worker.on("message", (message) => {
      if (settled) return;
      settled = true;
      resolve(message);
    });
    worker.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    worker.on("exit", (code) => {
      if (!settled && code !== 0) reject(new Error(`race worker exited ${code}`));
    });
  });
}

test("concurrent equivalent actions with distinct fingerprints cross the side-effect boundary at most once", async () => {
  const root = tmp();
  const sharedBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const shared = new Int32Array(sharedBuffer);
  const moduleUrl = pathToFileURL(path.join(import.meta.dirname, "devexec-side-effect-fingerprint-guard.mjs")).href;
  const [first, second] = await Promise.all([
    runConcurrentWorker({
      moduleUrl,
      stateDir: root,
      actionValue: action({ prior_attempt_id: "attempt-a", distinct_reason: "concurrent-a" }),
      shared: sharedBuffer,
    }),
    runConcurrentWorker({
      moduleUrl,
      stateDir: root,
      actionValue: action({ prior_attempt_id: "attempt-b", distinct_reason: "concurrent-b" }),
      shared: sharedBuffer,
    }),
  ]);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(Atomics.load(shared, 0), 2);
  assert.equal(Atomics.load(shared, 1), 1, `results=${JSON.stringify([first, second])}`);
  assert.ok([first.decision, second.decision].includes("PASS"));
});


test("orphaned equivalence ownership remains fail-closed and is never replayed", async () => {
  const root = tmp();
  const derived = deriveSideEffectFingerprint(action());
  const originalOpenSync = fs.openSync.bind(fs);
  const firstHarness = harness();
  fs.openSync = function(file, flags, ...args) {
    if (flags === "wx" && path.basename(String(file)) === `${derived.fingerprint}.json`) {
      const error = new Error("injected fingerprint persistence failure");
      error.code = "EACCES";
      throw error;
    }
    return originalOpenSync(file, flags, ...args);
  };
  try {
    await assert.rejects(
      () => runSideEffectWithFingerprintGuard({ stateDir: root, action: action(), ...firstHarness }),
      (error) => error?.code === "SIDE_EFFECT_GUARD_FINGERPRINT_RECORD_FAILED",
    );
  } finally {
    fs.openSync = originalOpenSync;
  }
  assert.equal(firstHarness.calls(), 0);

  const secondHarness = harness();
  const second = await runSideEffectWithFingerprintGuard({
    stateDir: root,
    action: action({ prior_attempt_id: "after-orphan", distinct_reason: "must-not-replay" }),
    ...secondHarness,
  });
  assert.equal(second.decision, "STOP");
  assert.equal(second.reason_code, "AMBIGUOUS_EQUIVALENCE_OWNER");
  assert.equal(second.record, null);
  assert.equal(secondHarness.calls(), 0);
});

test("corrupt equivalence ownership fails closed before any connector call", async () => {
  const root = tmp();
  const derived = deriveSideEffectFingerprint(action());
  const claimRoot = path.join(root, "side-effect-fingerprints-v1", "equivalence-claims-v1");
  fs.mkdirSync(claimRoot, { recursive: true });
  fs.writeFileSync(path.join(claimRoot, `${derived.equivalence_key}.claim`), "tampered", "utf8");

  const h = harness();
  await assert.rejects(
    () => runSideEffectWithFingerprintGuard({ stateDir: root, action: action(), ...h }),
    (error) => error?.code === "SIDE_EFFECT_GUARD_CORRUPT",
  );
  assert.equal(h.calls(), 0);
});

test("an in-flight equivalent action blocks a second distinct fingerprint without replay", async () => {
  const root = tmp();
  let releaseExecute;
  let enteredExecute;
  const entered = new Promise((resolve) => { enteredExecute = resolve; });
  const hold = new Promise((resolve) => { releaseExecute = resolve; });
  let firstCalls = 0;

  const firstPromise = runSideEffectWithFingerprintGuard({
    stateDir: root,
    action: action({ prior_attempt_id: "first", distinct_reason: "first-owner" }),
    readControlIdentity: async () => ({ identity: "ledger:control-v1", decision: "ALLOW" }),
    readPrecondition: async () => action().expected_precondition,
    execute: async () => {
      firstCalls += 1;
      enteredExecute();
      await hold;
      return { ok: true };
    },
    readBack: async () => ({ state: "MATCH", identity: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
  });
  await entered;

  const secondHarness = harness();
  const second = await runSideEffectWithFingerprintGuard({
    stateDir: root,
    action: action({ prior_attempt_id: "second", distinct_reason: "concurrent-retry" }),
    ...secondHarness,
  });
  assert.equal(second.decision, "STOP");
  assert.equal(second.reason_code, "AMBIGUOUS_PRIOR_ATTEMPT");
  assert.equal(second.record.status, "IN_FLIGHT");
  assert.equal(secondHarness.calls(), 0);

  releaseExecute();
  const first = await firstPromise;
  assert.equal(first.decision, "PASS");
  assert.equal(firstCalls, 1);
});
