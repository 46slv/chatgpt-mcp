import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSideEffectWithFingerprintGuard } from "./devexec-side-effect-fingerprint-guard.mjs";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "devexec-side-effect-target-revalidation-"));
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

async function runTargetRevalidation(secondRead) {
  const events = [];
  let controlReads = 0;
  let preconditionReads = 0;
  let sideEffects = 0;
  const result = await runSideEffectWithFingerprintGuard({
    stateDir: tmp(),
    action: action(),
    readControlIdentity: async () => {
      controlReads += 1;
      events.push(`control-${controlReads}`);
      return { identity: "ledger:control-v1", decision: "ALLOW" };
    },
    readPrecondition: async () => {
      preconditionReads += 1;
      events.push(`precondition-${preconditionReads}`);
      if (preconditionReads === 1) return action().expected_precondition;
      return secondRead();
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
  return { result, events, sideEffects, controlReads, preconditionReads };
}

function assertStoppedBeforeExecute(observed, reasonCode) {
  assert.equal(observed.result.decision, "STOP");
  assert.equal(observed.result.reason_code, reasonCode);
  assert.equal(observed.result.record.status, "STOPPED");
  assert.equal(observed.result.record.side_effect_count, 0);
  assert.equal(observed.sideEffects, 0);
  assert.equal(observed.controlReads, 2);
  assert.equal(observed.preconditionReads, 2);
  assert.deepEqual(observed.events, ["control-1", "precondition-1", "control-2", "precondition-2"]);
}

test("second target read failure stops before external side effect", async () => {
  const observed = await runTargetRevalidation(() => { throw new Error("target unavailable"); });
  assertStoppedBeforeExecute(observed, "PRECONDITION_REVALIDATION_FAILED");
  assert.match(observed.result.record.diagnostic, /target unavailable/);
});

test("target identity drift after the first precondition read stops before external side effect", async () => {
  const changed = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
  const observed = await runTargetRevalidation(() => changed);
  assertStoppedBeforeExecute(observed, "PRECONDITION_CHANGED");
  assert.equal(observed.result.record.precondition_identity, changed);
  assert.match(observed.result.record.diagnostic, /initial=sha256:aaaaaaaa/);
});

test("unchanged target is re-read after control and immediately before execute", async () => {
  const observed = await runTargetRevalidation(() => action().expected_precondition);
  assert.equal(observed.result.decision, "PASS");
  assert.equal(observed.result.record.status, "SUCCEEDED");
  assert.equal(observed.result.record.side_effect_count, 1);
  assert.equal(observed.sideEffects, 1);
  assert.equal(observed.controlReads, 2);
  assert.equal(observed.preconditionReads, 2);
  assert.deepEqual(observed.events, [
    "control-1",
    "precondition-1",
    "control-2",
    "precondition-2",
    "execute",
    "readback",
  ]);
});
