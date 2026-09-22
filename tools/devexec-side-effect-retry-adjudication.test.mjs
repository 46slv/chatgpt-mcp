import test from "node:test";
import assert from "node:assert/strict";
import {
  adjudicateDistinctSideEffectRetry,
  SIDE_EFFECT_RETRY_ADJUDICATION_PROTOCOL,
} from "./devexec-side-effect-retry-adjudication.mjs";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

function prior(overrides = {}) {
  return {
    fingerprint: A,
    equivalence_key: C,
    surface: "github",
    action_type: "update_ref",
    target: "46slv/example:refs/heads/candidate",
    immutable_input: "candidate:immutable-sha",
    status: "FAILED",
    reason_code: "NO_EFFECT_PROVEN",
    control_identity: "ledger:control-v1",
    ...overrides,
  };
}
function proposed(overrides = {}) {
  return {
    fingerprint: B,
    equivalence_key: C,
    surface: "github",
    action_type: "update_ref",
    target: "46slv/example:refs/heads/candidate",
    immutable_input: "candidate:immutable-sha",
    control_identity: "ledger:control-v2",
    prior_attempt_id: A,
    distinct_reason: "new authority permits one distinct retry",
    ...overrides,
  };
}
function authority(overrides = {}) {
  return {
    identity: "ledger:control-v2",
    decision: "ALLOW_DISTINCT_RETRY",
    supersedes_control_identity: "ledger:control-v1",
    prior_fingerprint: A,
    next_fingerprint: B,
    equivalence_key: C,
    retry_contract_identity: "retry-contract:github-update-ref-v3",
    ...overrides,
  };
}
function retryContract(overrides = {}) {
  return {
    identity: "retry-contract:github-update-ref-v3",
    decision: "ALLOW",
    surface: "github",
    action_type: "update_ref",
    prior_status: "FAILED",
    prior_reason_code: "NO_EFFECT_PROVEN",
    ...overrides,
  };
}
async function run({ p = prior(), n = proposed(), a = authority(), c = retryContract(), authorityError = null, contractError = null } = {}) {
  let authorityReads = 0;
  let contractReads = 0;
  const result = await adjudicateDistinctSideEffectRetry({
    prior: p,
    proposed: n,
    readRetryAuthority: async () => { authorityReads += 1; if (authorityError) throw authorityError; return a; },
    readRetryContract: async () => { contractReads += 1; if (contractError) throw contractError; return c; },
  });
  return { result, authorityReads, contractReads };
}

test("fresh newer authority plus exact live retry contract yields an adjudication only, not execution authority", async () => {
  const { result, authorityReads, contractReads } = await run();
  assert.equal(result.decision, "ALLOW_DISTINCT_RETRY");
  assert.equal(result.side_effect_permitted_by_this_primitive, false);
  assert.equal(result.adjudication.protocol, SIDE_EFFECT_RETRY_ADJUDICATION_PROTOCOL);
  assert.equal(result.adjudication.prior_fingerprint, A);
  assert.equal(result.adjudication.next_fingerprint, B);
  assert.match(result.adjudication_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(authorityReads, 1);
  assert.equal(contractReads, 1);
});

test("a succeeded prior action remains a duplicate without consulting retry authority", async () => {
  const { result, authorityReads, contractReads } = await run({ p: prior({ status: "SUCCEEDED", reason_code: null }) });
  assert.equal(result.decision, "DUPLICATE");
  assert.equal(result.reason_code, "SIDE_EFFECT_ALREADY_SUCCEEDED");
  assert.equal(authorityReads, 0);
  assert.equal(contractReads, 0);
});

test("ambiguous and in-flight prior outcomes are never retry-adjudicated", async () => {
  for (const status of ["AMBIGUOUS", "IN_FLIGHT", "PREPARED", "STOPPED"]) {
    const { result, authorityReads } = await run({ p: prior({ status, reason_code: "OUTCOME_UNKNOWN" }) });
    assert.equal(result.reason_code, "PRIOR_OUTCOME_NOT_RETRYABLE", status);
    assert.equal(authorityReads, 0, status);
  }
});

test("immutable action drift is rejected before authority read", async () => {
  const { result, authorityReads } = await run({ n: proposed({ target: "46slv/example:refs/heads/other" }) });
  assert.equal(result.reason_code, "IMMUTABLE_ACTION_CHANGED");
  assert.equal(authorityReads, 0);
});

test("exact prior-attempt binding and distinct reason are mandatory", async () => {
  const mismatch = await run({ n: proposed({ prior_attempt_id: B }) });
  assert.equal(mismatch.result.reason_code, "PRIOR_ATTEMPT_MISMATCH");
  assert.equal(mismatch.authorityReads, 0);
  const missingReason = await run({ n: proposed({ distinct_reason: null }) });
  assert.equal(missingReason.result.reason_code, "DISTINCT_REASON_REQUIRED");
  assert.equal(missingReason.authorityReads, 0);
});

test("retry authority deny or STOP never consults the retry contract", async () => {
  const denied = await run({ a: authority({ decision: "DENY" }) });
  assert.equal(denied.result.reason_code, "RETRY_AUTHORITY_DENIED");
  assert.equal(denied.contractReads, 0);
  const stopped = await run({ a: authority({ decision: "STOP" }) });
  assert.equal(stopped.result.reason_code, "RETRY_AUTHORITY_STOP");
  assert.equal(stopped.contractReads, 0);
});

test("authority must be fresh, superseding, and bind exact prior/next/equivalence identities", async () => {
  const stale = await run({ a: authority({ identity: "ledger:control-v3" }) });
  assert.equal(stale.result.reason_code, "STALE_RETRY_AUTHORITY");
  const notSuperseding = await run({ a: authority({ supersedes_control_identity: "ledger:older" }) });
  assert.equal(notSuperseding.result.reason_code, "RETRY_AUTHORITY_NOT_SUPERSEDING");
  const badBinding = await run({ a: authority({ next_fingerprint: A }) });
  assert.equal(badBinding.result.reason_code, "RETRY_AUTHORITY_BINDING_MISMATCH");
});

test("authority read failure is fail-closed", async () => {
  const { result, contractReads } = await run({ authorityError: new Error("ledger unavailable") });
  assert.equal(result.reason_code, "RETRY_AUTHORITY_READ_FAILED");
  assert.equal(contractReads, 0);
});

test("retry contract must be live, allowed, identity-bound, and exact for the prior terminal row", async () => {
  const denied = await run({ c: retryContract({ decision: "DENY" }) });
  assert.equal(denied.result.reason_code, "RETRY_CONTRACT_DENIED");
  const identityMismatch = await run({ c: retryContract({ identity: "retry-contract:other" }) });
  assert.equal(identityMismatch.result.reason_code, "RETRY_CONTRACT_IDENTITY_MISMATCH");
  const bindingMismatch = await run({ c: retryContract({ prior_reason_code: "OTHER" }) });
  assert.equal(bindingMismatch.result.reason_code, "RETRY_CONTRACT_BINDING_MISMATCH");
  const unavailable = await run({ contractError: new Error("contract unavailable") });
  assert.equal(unavailable.result.reason_code, "RETRY_CONTRACT_READ_FAILED");
});

test("same full fingerprint cannot be relabeled as a distinct retry", async () => {
  const { result, authorityReads } = await run({ n: proposed({ fingerprint: A }) });
  assert.equal(result.reason_code, "DISTINCT_FINGERPRINT_REQUIRED");
  assert.equal(authorityReads, 0);
});

test("malformed authority payload fails closed as a contract violation", async () => {
  await assert.rejects(
    () => adjudicateDistinctSideEffectRetry({
      prior: prior(),
      proposed: proposed(),
      readRetryAuthority: async () => ({ decision: "ALLOW_DISTINCT_RETRY" }),
      readRetryContract: async () => retryContract(),
    }),
    (error) => error?.code === "SIDE_EFFECT_RETRY_INVALID",
  );
});
