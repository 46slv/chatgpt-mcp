import test from "node:test";
import assert from "node:assert/strict";
import {
  ScheduledWorkerGitHubSideEffectError,
  adjudicateScheduledWorkerGitHubRetry,
  deriveScheduledWorkerGitHubAction,
  inspectScheduledWorkerGitHubMutation,
  runScheduledWorkerGitHubMutation,
} from "./devexec-scheduled-worker-github-side-effect.mjs";

const PRE = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const POST = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PRIOR = "c".repeat(64);
const EQUIV = "d".repeat(64);

function mutation(overrides = {}) {
  return {
    repository: "46slv/example",
    operation: "update_ref",
    resource: "refs/heads/candidate",
    payload: { sha: "e".repeat(40), force: false },
    expected_precondition: PRE,
    expected_post_identity: POST,
    control_identity: "ledger:control-v2",
    prior_attempt_id: null,
    distinct_reason: null,
    ...overrides,
  };
}

function fakeDerived(action) {
  return { action, fingerprint: "f".repeat(64), equivalence_key: EQUIV };
}

function behavioralGuard() {
  return async ({ action, readControlIdentity, readPrecondition, execute, readBack }) => {
    const control = await readControlIdentity();
    if (control.identity !== action.control_identity || control.decision !== "ALLOW") {
      return { decision: "STOP", reason_code: "STALE_CONTROL" };
    }
    if (await readPrecondition() !== action.expected_precondition) {
      return { decision: "STOP", reason_code: "PRECONDITION_MISMATCH" };
    }
    await execute();
    const post = await readBack();
    if (post.state === "MATCH") return { decision: "PASS", reason_code: null, post };
    return { decision: "STOP", reason_code: post.state === "MISMATCH" ? "POSTCONDITION_MISMATCH" : "OUTCOME_UNKNOWN", post };
  };
}

test("action fingerprint is deterministic across payload key order and binds exact GitHub surface", () => {
  const first = deriveScheduledWorkerGitHubAction(mutation({ payload: { sha: "e".repeat(40), force: false } }));
  const second = deriveScheduledWorkerGitHubAction(mutation({ payload: { force: false, sha: "e".repeat(40) } }));
  assert.equal(first.mutation.payload_fingerprint, second.mutation.payload_fingerprint);
  assert.deepEqual(first.action, second.action);
  assert.equal(first.action.surface, "github-scheduled-worker");
  assert.equal(first.action.target, "46slv/example:refs/heads/candidate");
  assert.match(first.action.immutable_input, /^sha256:[a-f0-9]{64}$/);
});

test("normalized payload is detached and frozen before control or connector callbacks", () => {
  const source = { sha: "e".repeat(40), force: false, nested: { mode: "safe" } };
  const derived = deriveScheduledWorkerGitHubAction(mutation({ payload: source }));
  source.sha = "0".repeat(40);
  source.nested.mode = "changed";
  assert.equal(derived.mutation.payload.sha, "e".repeat(40));
  assert.equal(derived.mutation.payload.nested.mode, "safe");
  assert.equal(Object.isFrozen(derived.mutation.payload), true);
  assert.equal(Object.isFrozen(derived.mutation.payload.nested), true);
  assert.throws(() => { derived.mutation.payload.sha = "1".repeat(40); }, TypeError);
});

test("destructive GitHub operations and force ref updates fail closed before connector use", () => {
  assert.throws(
    () => deriveScheduledWorkerGitHubAction(mutation({ operation: "merge_pull_request" })),
    (error) => error instanceof ScheduledWorkerGitHubSideEffectError && error.code === "SCHEDULED_WORKER_SIDE_EFFECT_UNSUPPORTED",
  );
  assert.throws(
    () => deriveScheduledWorkerGitHubAction(mutation({ payload: { sha: "e".repeat(40), force: true } })),
    (error) => error instanceof ScheduledWorkerGitHubSideEffectError && error.code === "SCHEDULED_WORKER_SIDE_EFFECT_UNSUPPORTED",
  );
});

test("scheduled-worker seam fresh-reads pre/post identities and crosses connector boundary once", async () => {
  const phases = [];
  let calls = 0;
  const result = await runScheduledWorkerGitHubMutation({
    stateDir: "/tmp/not-used-by-fake",
    mutation: mutation(),
    readControlIdentity: async ({ mutation: normalized, action }) => {
      assert.equal(normalized.repository, "46slv/example");
      assert.equal(action.surface, "github-scheduled-worker");
      return { identity: "ledger:control-v2", decision: "ALLOW" };
    },
    readGitHubIdentity: async ({ phase }) => { phases.push(phase); return phase === "PRE" ? PRE : POST; },
    executeGitHubMutation: async ({ mutation: normalized }) => { calls += 1; assert.equal(normalized.payload_fingerprint.startsWith("sha256:"), true); },
    dependencies: { runSideEffectWithFingerprintGuard: behavioralGuard() },
  });
  assert.equal(result.decision, "PASS");
  assert.equal(calls, 1);
  assert.deepEqual(phases, ["PRE", "POST"]);
});

test("stale GitHub precondition stops before connector mutation", async () => {
  let calls = 0;
  const result = await runScheduledWorkerGitHubMutation({
    stateDir: "/tmp/not-used-by-fake",
    mutation: mutation(),
    readControlIdentity: async () => ({ identity: "ledger:control-v2", decision: "ALLOW" }),
    readGitHubIdentity: async ({ phase }) => phase === "PRE" ? "sha256:stale" : POST,
    executeGitHubMutation: async () => { calls += 1; },
    dependencies: { runSideEffectWithFingerprintGuard: behavioralGuard() },
  });
  assert.equal(result.reason_code, "PRECONDITION_MISMATCH");
  assert.equal(calls, 0);
});

test("post-write mismatch and read failure never become PASS or automatic replay", async () => {
  let mismatchCalls = 0;
  const mismatch = await runScheduledWorkerGitHubMutation({
    stateDir: "/tmp/not-used-by-fake",
    mutation: mutation(),
    readControlIdentity: async () => ({ identity: "ledger:control-v2", decision: "ALLOW" }),
    readGitHubIdentity: async ({ phase }) => phase === "PRE" ? PRE : "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    executeGitHubMutation: async () => { mismatchCalls += 1; },
    dependencies: { runSideEffectWithFingerprintGuard: behavioralGuard() },
  });
  assert.equal(mismatch.reason_code, "POSTCONDITION_MISMATCH");
  assert.equal(mismatchCalls, 1);

  let unknownCalls = 0;
  const unknown = await runScheduledWorkerGitHubMutation({
    stateDir: "/tmp/not-used-by-fake",
    mutation: mutation(),
    readControlIdentity: async () => ({ identity: "ledger:control-v2", decision: "ALLOW" }),
    readGitHubIdentity: async ({ phase }) => { if (phase === "PRE") return PRE; throw new Error("connector read failed"); },
    executeGitHubMutation: async () => { unknownCalls += 1; },
    dependencies: { runSideEffectWithFingerprintGuard: behavioralGuard() },
  });
  assert.equal(unknown.reason_code, "OUTCOME_UNKNOWN");
  assert.equal(unknownCalls, 1);
});

test("read-only inspection exposes the shared equivalence state without opening execution", async () => {
  const seen = [];
  const result = await inspectScheduledWorkerGitHubMutation({
    stateDir: "/state",
    mutation: mutation(),
    dependencies: {
      inspectSideEffectEquivalenceState: ({ stateDir, action }) => { seen.push({ stateDir, action }); return { state: "OWNER_ONLY", record: null }; },
    },
  });
  assert.equal(result.inspection.state, "OWNER_ONLY");
  assert.equal(result.mutation.operation, "update_ref");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].action.surface, "github-scheduled-worker");
});

test("owner-only residue blocks distinct retry adjudication and does not consult authority", async () => {
  let authorityReads = 0;
  let contractReads = 0;
  let adjudications = 0;
  const result = await adjudicateScheduledWorkerGitHubRetry({
    stateDir: "/state",
    mutation: mutation({ prior_attempt_id: PRIOR, distinct_reason: "explicit retry" }),
    readRetryAuthority: async () => { authorityReads += 1; return {}; },
    readRetryContract: async () => { contractReads += 1; return {}; },
    dependencies: {
      deriveSideEffectFingerprint: fakeDerived,
      inspectSideEffectEquivalenceState: () => ({ state: "OWNER_ONLY", record: null }),
      adjudicateDistinctSideEffectRetry: async () => { adjudications += 1; return {}; },
    },
  });
  assert.equal(result.decision, "STOP");
  assert.equal(result.reason_code, "OWNER_ONLY_REQUIRES_OPERATOR_ADJUDICATION");
  assert.equal(result.side_effect_permitted, false);
  assert.equal(authorityReads, 0);
  assert.equal(contractReads, 0);
  assert.equal(adjudications, 0);
});

test("recorded failed attempt is bound into retry adjudication but execution gate stays closed", async () => {
  const current = mutation({ prior_attempt_id: PRIOR, distinct_reason: "new authority permits one distinct retry" });
  const { action } = deriveScheduledWorkerGitHubAction(current);
  const priorRecord = {
    fingerprint: PRIOR,
    equivalence_key: EQUIV,
    action: { ...action, control_identity: "ledger:control-v1", prior_attempt_id: null, distinct_reason: null },
    status: "FAILED",
    reason_code: "NO_EFFECT_PROVEN",
  };
  let captured;
  const result = await adjudicateScheduledWorkerGitHubRetry({
    stateDir: "/state",
    mutation: current,
    readRetryAuthority: async () => ({ identity: "ledger:control-v2" }),
    readRetryContract: async () => ({ identity: "retry-contract:v1" }),
    dependencies: {
      deriveSideEffectFingerprint: fakeDerived,
      inspectSideEffectEquivalenceState: () => ({ state: "RECORDED", record: priorRecord }),
      adjudicateDistinctSideEffectRetry: async (input) => {
        captured = input;
        return {
          decision: "ALLOW_DISTINCT_RETRY",
          reason_code: null,
          side_effect_permitted_by_this_primitive: false,
          adjudication_fingerprint: "a".repeat(64),
        };
      },
    },
  });
  assert.equal(captured.prior.fingerprint, PRIOR);
  assert.equal(captured.prior.control_identity, "ledger:control-v1");
  assert.equal(captured.proposed.prior_attempt_id, PRIOR);
  assert.equal(captured.proposed.distinct_reason, "new authority permits one distinct retry");
  assert.equal(result.decision, "ALLOW_DISTINCT_RETRY");
  assert.equal(result.side_effect_permitted_by_this_primitive, false);
  assert.equal(result.side_effect_permitted, false);
  assert.equal(result.execution_gate, "CLOSED");
});
