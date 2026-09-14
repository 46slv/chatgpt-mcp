import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSideEffectWithFingerprintGuard } from "./devexec-side-effect-fingerprint-guard.mjs";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "devexec-side-effect-control-revalidation-"));
}

function action() {
  return {
    surface: "github",
    action_type: "update_ref",
    target: "46slv/example:refs/heads/candidate",
    immutable_input: "candidate:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    expected_precondition: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    prior_attempt_id: null,
    control_identity: "ledger:control-v1",
    distinct_reason: null,
  };
}

async function runRevocation(secondRead) {
  const events = [];
  let controlReads = 0;
  let sideEffects = 0;
  const result = await runSideEffectWithFingerprintGuard({
    stateDir: tmp(),
    action: action(),
    readControlIdentity: async () => {
      controlReads += 1;
      events.push(`control-${controlReads}`);
      if (controlReads === 1) return { identity: "ledger:control-v1", decision: "ALLOW" };
      return secondRead();
    },
    readPrecondition: async () => {
      events.push("precondition");
      return action().expected_precondition;
    },
    execute: async () => {
      events.push("execute");
      sideEffects += 1;
      return { ok: true };
    },
    readBack: async () => {
      events.push("readback");
      return { state: "MATCH", identity: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
    },
  });
  return { result, events, sideEffects, controlReads };
}

function assertStoppedBeforeExecute(observed, reasonCode) {
  assert.equal(observed.result.decision, "STOP");
  assert.equal(observed.result.reason_code, reasonCode);
  assert.equal(observed.result.record.status, "STOPPED");
  assert.equal(observed.result.record.side_effect_count, 0);
  assert.equal(observed.sideEffects, 0);
  assert.equal(observed.controlReads, 2);
  assert.deepEqual(observed.events, ["control-1", "precondition", "control-2"]);
}

test("second control read failure stops before external side effect", async () => {
  const observed = await runRevocation(() => { throw new Error("control unavailable"); });
  assertStoppedBeforeExecute(observed, "CONTROL_REVALIDATION_FAILED");
  assert.match(observed.result.record.diagnostic, /control unavailable/);
});

test("changed control identity after precondition stops before external side effect", async () => {
  const observed = await runRevocation(() => ({ identity: "ledger:newer", decision: "ALLOW" }));
  assertStoppedBeforeExecute(observed, "STALE_CONTROL");
  assert.match(observed.result.record.diagnostic, /ledger:newer/);
});

test("FROZEN on second control read stops before external side effect", async () => {
  const observed = await runRevocation(() => ({ identity: "ledger:control-v1", decision: "FROZEN" }));
  assertStoppedBeforeExecute(observed, "FROZEN");
});

test("STOP on second control read stops before external side effect", async () => {
  const observed = await runRevocation(() => ({ identity: "ledger:control-v1", decision: "STOP" }));
  assertStoppedBeforeExecute(observed, "CONTROL_STOP");
});
