import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  EPHEMERAL_REASONING_RESULT_SCHEMA,
  createEphemeralReasoningState,
  validateEphemeralReasoningState,
  openEphemeralReasoningEpisode,
  applyEphemeralReasoningResult,
  resolveEphemeralContextRequest,
  ephemeralReasoningStateDigest,
} from "./devexec-ephemeral-reasoning-state.mjs";

const digest = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const base = () => createEphemeralReasoningState({
  mission_id: "M-DEV-LER-TEST",
  goal_id: "DEV-LER-001",
  goal: { text: "Finish two bounded verified problems", acceptance: ["P1 and P2 solved"], required_evidence_refs: ["ev:goal"] },
  constraints: ["fresh context per episode", "no transcript forwarding"],
  approved_context_refs: ["ctx:base"],
});
const result = (episode, outcome, overrides = {}) => ({
  schema: EPHEMERAL_REASONING_RESULT_SCHEMA,
  schema_version: 1,
  episode_id: episode.episode_id,
  role: episode.role,
  outcome,
  summary: `${episode.role}:${outcome}`,
  evidence_refs: [],
  problem: null,
  context_request_refs: [],
  verified_facts: [],
  ...overrides,
});
const open = (state, extra = {}) => openEphemeralReasoningEpisode(state, { max_input_bytes: 8192, max_output_bytes: 4096, ...extra });

function findProblem(state, problem_id, required = []) {
  const ep = open(state);
  assert.equal(ep.role, "FIND");
  return applyEphemeralReasoningResult(state, ep, result(ep, "FOUND", { problem: { problem_id, statement: `Solve ${problem_id}`, required_evidence_refs: required } }));
}
function solveAttempt(state, summary = "attempt") {
  const ep = open(state);
  assert.equal(ep.role, "SOLVE");
  return [applyEphemeralReasoningResult(state, ep, result(ep, "ATTEMPTED", { summary })), ep];
}

test("bounded 12-episode mission has distinct fresh episode identities and separates SOLVED from COMPLETE", () => {
  let state = base();
  const ids = [];
  const capture = (ep) => { ids.push(ep.episode_id); assert.equal(ep.session_policy, "FRESH_CONTEXT_REQUIRED"); assert.equal(ep.forward_transcript, false); };

  let ep = open(state); capture(ep); state = applyEphemeralReasoningResult(state, ep, result(ep, "FOUND", { problem: { problem_id: "P1", statement: "solve p1", required_evidence_refs: ["ev:p1"] } }));
  for (let index = 0; index < 3; index += 1) {
    ep = open(state); capture(ep); state = applyEphemeralReasoningResult(state, ep, result(ep, "ATTEMPTED", { summary: "same-size-attempt" }));
    ep = open(state); capture(ep);
    if (index < 2) state = applyEphemeralReasoningResult(state, ep, result(ep, "UNSOLVED"));
    else state = applyEphemeralReasoningResult(state, ep, result(ep, "SOLVED", { evidence_refs: ["ev:p1"] }));
  }
  assert.equal(state.next_role, "GOAL_CHECK"); assert.equal(state.terminal, null);
  ep = open(state); capture(ep); state = applyEphemeralReasoningResult(state, ep, result(ep, "INCOMPLETE"));
  ep = open(state); capture(ep); state = applyEphemeralReasoningResult(state, ep, result(ep, "FOUND", { problem: { problem_id: "P2", statement: "solve p2", required_evidence_refs: [] } }));
  ep = open(state); capture(ep); state = applyEphemeralReasoningResult(state, ep, result(ep, "ATTEMPTED"));
  ep = open(state); capture(ep); state = applyEphemeralReasoningResult(state, ep, result(ep, "SOLVED"));
  assert.equal(state.terminal, null); assert.equal(state.next_role, "GOAL_CHECK");
  ep = open(state); capture(ep); state = applyEphemeralReasoningResult(state, ep, result(ep, "COMPLETE", { evidence_refs: ["ev:goal"] }));

  assert.equal(ids.length, 12);
  assert.equal(new Set(ids).size, 12);
  assert.equal(state.terminal, "COMPLETE");
  assert.equal(state.next_role, "STOP");
  assert.deepEqual(state.solved_problem_ids, ["P1", "P2"]);
});

test("three UNSOLVED cycles do not accumulate prior model context into SOLVE projection", () => {
  let state = findProblem(base(), "P1");
  const solveInputSizes = [];
  for (let index = 0; index < 3; index += 1) {
    const ep = open(state); solveInputSizes.push(ep.input_bytes);
    assert.equal(ep.role, "SOLVE");
    assert.ok(!("attempts" in ep.input));
    assert.ok(ep.input.prior_attempt === null || ep.input.prior_attempt.problem_id === "P1");
    state = applyEphemeralReasoningResult(state, ep, result(ep, "ATTEMPTED", { summary: "fixed-attempt" }));
    const verifyEp = open(state);
    state = applyEphemeralReasoningResult(state, verifyEp, result(verifyEp, "UNSOLVED"));
  }
  assert.equal(state.attempts.length, 3);
  assert.equal(solveInputSizes[1], solveInputSizes[2]);
  assert.ok(Math.max(...solveInputSizes) < 8192);
});

test("NEEDS_CONTEXT ends the episode and requires parent resolution before a fresh SOLVE episode", () => {
  let state = findProblem(base(), "P-context");
  const requesting = open(state);
  state = applyEphemeralReasoningResult(state, requesting, result(requesting, "NEEDS_CONTEXT", { context_request_refs: ["ctx:extra"] }));
  assert.deepEqual(state.pending_context_request_refs, ["ctx:extra"]);
  assert.throws(() => open(state), /parent resolution/);
  assert.equal(JSON.stringify(state).includes("extra material contents"), false);

  state = resolveEphemeralContextRequest(state, { approved_refs: ["ctx:extra"] });
  const content = "approved bounded extra material";
  const resumed = open(state, { working_set: [{ ref: "ctx:extra", kind: "file", sha256: digest(content), content }] });
  assert.equal(resumed.role, "SOLVE");
  assert.notEqual(resumed.episode_id, requesting.episode_id);
  assert.equal(resumed.sequence, requesting.sequence + 1);
  assert.equal(JSON.stringify(state).includes(content), false);
});

test("parent cannot smuggle unrequested context through NEEDS_CONTEXT resolution", () => {
  let state = findProblem(base(), "P-context");
  const ep = open(state);
  state = applyEphemeralReasoningResult(state, ep, result(ep, "NEEDS_CONTEXT", { context_request_refs: ["ctx:requested"] }));
  assert.throws(() => resolveEphemeralContextRequest(state, { approved_refs: ["ctx:not-requested"] }), /unrequested/);
});

test("SOLVED and COMPLETE fail closed without their deterministic evidence", () => {
  let state = findProblem(base(), "P-evidence", ["ev:problem"]);
  [state] = solveAttempt(state);
  const verifyEp = open(state);
  assert.throws(() => applyEphemeralReasoningResult(state, verifyEp, result(verifyEp, "SOLVED")), /missing required deterministic evidence/);
  state = applyEphemeralReasoningResult(state, verifyEp, result(verifyEp, "SOLVED", { evidence_refs: ["ev:problem"] }));
  const goalEp = open(state);
  assert.throws(() => applyEphemeralReasoningResult(state, goalEp, result(goalEp, "COMPLETE")), /missing required deterministic evidence/);
});

test("Solver cannot self-certify SOLVED and stale episode results cannot advance state", () => {
  let state = findProblem(base(), "P1");
  const solveEp = open(state);
  assert.throws(() => applyEphemeralReasoningResult(state, solveEp, result(solveEp, "SOLVED")), /outcome invalid for SOLVE/);
  state = applyEphemeralReasoningResult(state, solveEp, result(solveEp, "ATTEMPTED"));
  assert.throws(() => applyEphemeralReasoningResult(state, solveEp, result(solveEp, "ATTEMPTED")), /stale or mismatched episode/);
});

test("durable state and results reject transcript/history-shaped authority", () => {
  const state = base();
  assert.throws(() => validateEphemeralReasoningState({ ...state, transcript: "hidden" }), /forbidden|unknown/);
  const ep = open(state);
  const bad = { ...result(ep, "FOUND", { problem: { problem_id: "P1", statement: "p1", required_evidence_refs: [] } }), history: ["old model message"] };
  assert.throws(() => applyEphemeralReasoningResult(state, ep, bad), /forbidden|unknown/);
});

test("working set must be parent-approved, content-addressed, and inside the per-episode byte budget", () => {
  const state = base();
  const content = "bounded file excerpt";
  const ep = open(state, { working_set: [{ ref: "ctx:base", kind: "file", sha256: digest(content), content }] });
  assert.ok(ep.input_bytes < ep.budgets.max_input_bytes);
  assert.throws(() => open(state, { working_set: [{ ref: "ctx:unapproved", kind: "file", sha256: digest(content), content }] }), /not approved/);
  assert.throws(() => open(state, { working_set: [{ ref: "ctx:base", kind: "file", sha256: "0".repeat(64), content }] }), /sha256 mismatch/);
  const large = "x".repeat(3000);
  assert.throws(() => open(state, { max_input_bytes: 1024, working_set: [{ ref: "ctx:base", kind: "file", sha256: digest(large), content: large }] }), /exceeds byte budget/);
});

test("JSON restart reconstructs the next episode from durable state without conversation memory", () => {
  let state = findProblem(base(), "P-restart");
  [state] = solveAttempt(state, "structured attempt only");
  const before = open(state);
  const restored = JSON.parse(JSON.stringify(state));
  assert.equal(ephemeralReasoningStateDigest(restored), ephemeralReasoningStateDigest(state));
  const after = open(restored);
  assert.equal(after.episode_id, before.episode_id);
  assert.equal(after.role, "VERIFY");
  assert.equal(JSON.stringify(restored).includes("conversation"), false);
});

test("verified facts require evidence carried by the same independent result", () => {
  let state = findProblem(base(), "P-fact");
  [state] = solveAttempt(state);
  const ep = open(state);
  const fact = { key: "fact.one", value: "verified", evidence_ref: "ev:fact" };
  assert.throws(() => applyEphemeralReasoningResult(state, ep, result(ep, "UNSOLVED", { verified_facts: [fact] })), /fact evidence/);
  state = applyEphemeralReasoningResult(state, ep, result(ep, "UNSOLVED", { evidence_refs: ["ev:fact"], verified_facts: [fact] }));
  assert.deepEqual(state.verified_facts, [fact]);
});
