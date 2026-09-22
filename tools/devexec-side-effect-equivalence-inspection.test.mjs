import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deriveSideEffectFingerprint,
  inspectSideEffectFingerprint,
  runSideEffectWithFingerprintGuard,
} from "./devexec-side-effect-fingerprint-guard.mjs";
import { inspectSideEffectEquivalenceState } from "./devexec-side-effect-equivalence-inspection.mjs";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "devexec-side-effect-inspection-")); }
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
    readPrecondition: async () => action().expected_precondition,
    execute: async () => { calls += 1; return { ok: true }; },
    readBack: async () => ({ state: "MATCH", identity: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
    ...overrides,
  };
}

test("fresh equivalence state is absent", () => {
  assert.equal(inspectSideEffectEquivalenceState({ stateDir: tmp(), action: action() }), null);
});

test("owner-only crash residue is inspectable without reopening execution", async () => {
  const root = tmp();
  const derived = deriveSideEffectFingerprint(action());
  const originalOpenSync = fs.openSync.bind(fs);
  const h = harness();
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
      () => runSideEffectWithFingerprintGuard({ stateDir: root, action: action(), ...h }),
      (error) => error?.code === "SIDE_EFFECT_GUARD_FINGERPRINT_RECORD_FAILED",
    );
  } finally {
    fs.openSync = originalOpenSync;
  }

  assert.equal(h.calls(), 0);
  assert.equal(inspectSideEffectFingerprint({ stateDir: root, action: action() }), null);
  const inspected = inspectSideEffectEquivalenceState({ stateDir: root, action: action() });
  assert.equal(inspected.state, "OWNER_ONLY");
  assert.equal(inspected.claim_present, true);
  assert.equal(inspected.record, null);
  assert.equal(inspected.equivalence_key, derived.equivalence_key);
});

test("equivalence inspection finds a validated prior record across retry metadata", async () => {
  const root = tmp();
  const h = harness();
  const first = await runSideEffectWithFingerprintGuard({ stateDir: root, action: action(), ...h });
  assert.equal(first.decision, "PASS");

  const retried = action({ prior_attempt_id: first.record.fingerprint, distinct_reason: "operator-inspection" });
  assert.equal(inspectSideEffectFingerprint({ stateDir: root, action: retried }), null);
  const inspected = inspectSideEffectEquivalenceState({ stateDir: root, action: retried });
  assert.equal(inspected.state, "RECORDED");
  assert.equal(inspected.claim_present, true);
  assert.equal(inspected.record.status, "SUCCEEDED");
  assert.equal(inspected.record.fingerprint, first.record.fingerprint);
  assert.notEqual(inspected.fingerprint, first.record.fingerprint);
});

test("corrupt owner residue remains fail-closed for inspection", () => {
  const root = tmp();
  const derived = deriveSideEffectFingerprint(action());
  const claimRoot = path.join(root, "side-effect-fingerprints-v1", "equivalence-claims-v1");
  fs.mkdirSync(claimRoot, { recursive: true });
  fs.writeFileSync(path.join(claimRoot, `${derived.equivalence_key}.claim`), "tampered", "utf8");
  assert.throws(
    () => inspectSideEffectEquivalenceState({ stateDir: root, action: action() }),
    (error) => error?.code === "SIDE_EFFECT_GUARD_CORRUPT",
  );
});
