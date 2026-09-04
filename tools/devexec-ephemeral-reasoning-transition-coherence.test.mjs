import test from "node:test";
import assert from "node:assert/strict";
import {
  EPHEMERAL_REASONING_RESULT_SCHEMA,
  createEphemeralReasoningState,
  validateEphemeralReasoningState,
  openEphemeralReasoningEpisode,
  applyEphemeralReasoningResult,
  resolveEphemeralContextRequest,
} from "./devexec-ephemeral-reasoning-state.mjs";

const base = () => createEphemeralReasoningState({
  mission_id: "M-DEV-LER-TRANSITION-TEST",
  goal_id: "DEV-LER-001",
  goal: { text: "Validate durable transition coherence", acceptance: ["one problem solved"], required_evidence_refs: ["ev:goal"] },
  constraints: ["fresh context per episode"],
  evidence_authority_refs: ["ev:goal", "ev:p", "ev:verify"],
  approved_context_refs: [],
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
const open = (state) => openEphemeralReasoningEpisode(state, { max_input_bytes: 8192, max_output_bytes: 4096 });

function findProblem(state, problemId = "P-transition") {
  const episode = open(state);
  return applyEphemeralReasoningResult(state, episode, result(episode, "FOUND", {
    problem: { problem_id: problemId, statement: `Solve ${problemId}`, required_evidence_refs: ["ev:p"] },
  }));
}
function solveAttempt(state) {
  const episode = open(state);
  return applyEphemeralReasoningResult(state, episode, result(episode, "ATTEMPTED"));
}
function verify(state, outcome) {
  const episode = open(state);
  return applyEphemeralReasoningResult(state, episode, result(episode, outcome, { evidence_refs: ["ev:p"] }));
}

test("restart rejects Worker-B counterexample: GOAL_CHECK/INCOMPLETE cannot coexist with post-FIND SOLVE state", () => {
  const state = findProblem(base());
  const impossible = structuredClone(state);
  impossible.last_result = {
    ...impossible.last_result,
    role: "GOAL_CHECK",
    outcome: "INCOMPLETE",
    summary: "forged prior transition",
    evidence_refs: ["ev:goal"],
  };
  assert.equal(impossible.next_role, "SOLVE");
  assert.ok(impossible.current_problem);
  assert.throws(() => validateEphemeralReasoningState(impossible), /GOAL_CHECK\/INCOMPLETE|transition coherence/);
});

test("SOLVE/NEEDS_CONTEXT restart binds last_result, latest attempt and unresolved pending refs", () => {
  let state = findProblem(base(), "P-context");
  const solveEpisode = open(state);
  state = applyEphemeralReasoningResult(state, solveEpisode, result(solveEpisode, "NEEDS_CONTEXT", {
    context_request_refs: ["ctx:a", "ctx:b"],
  }));
  assert.doesNotThrow(() => validateEphemeralReasoningState(state));

  const pendingMismatch = structuredClone(state);
  pendingMismatch.pending_context_request_refs = ["ctx:other"];
  assert.throws(() => validateEphemeralReasoningState(pendingMismatch), /pending refs must match latest attempt/);

  const attemptMismatch = structuredClone(state);
  attemptMismatch.attempts.at(-1).summary = "different durable attempt";
  assert.throws(() => validateEphemeralReasoningState(attemptMismatch), /last_result does not match durable solve attempt/);

  const resolved = resolveEphemeralContextRequest(state, { approved_refs: ["ctx:a"] });
  assert.deepEqual(resolved.pending_context_request_refs, []);
  assert.doesNotThrow(() => validateEphemeralReasoningState(resolved));
});

test("restart rejects impossible attempt episode chronology", () => {
  let state = findProblem(base(), "P-order");
  state = solveAttempt(state);
  state = verify(state, "UNSOLVED");
  state = solveAttempt(state);
  assert.equal(state.next_role, "VERIFY");
  assert.equal(state.attempts.length, 2);

  const reversed = structuredClone(state);
  reversed.attempts.reverse();
  assert.throws(() => validateEphemeralReasoningState(reversed), /attempt episode ordering|latest attempt/);

  const future = structuredClone(state);
  future.attempts[0].episode_id = "E999999-deadbeefdeadbeef";
  assert.throws(() => validateEphemeralReasoningState(future), /attempt episode ordering/);
});

test("canonical reducer states remain valid across VERIFY/SOLVED, GOAL_CHECK/INCOMPLETE and COMPLETE", () => {
  let state = findProblem(base(), "P-one");
  state = solveAttempt(state);
  state = verify(state, "SOLVED");
  assert.equal(state.next_role, "GOAL_CHECK");
  assert.doesNotThrow(() => validateEphemeralReasoningState(state));

  let goalEpisode = open(state);
  state = applyEphemeralReasoningResult(state, goalEpisode, result(goalEpisode, "INCOMPLETE", { evidence_refs: ["ev:goal"] }));
  assert.equal(state.next_role, "FIND");
  assert.equal(state.current_problem, null);
  assert.doesNotThrow(() => validateEphemeralReasoningState(state));

  state = findProblem(state, "P-two");
  state = solveAttempt(state);
  state = verify(state, "SOLVED");
  goalEpisode = open(state);
  state = applyEphemeralReasoningResult(state, goalEpisode, result(goalEpisode, "COMPLETE", { evidence_refs: ["ev:goal"] }));
  assert.equal(state.terminal, "COMPLETE");
  assert.equal(state.next_role, "STOP");
  assert.doesNotThrow(() => validateEphemeralReasoningState(state));
});

test("restart rejects VERIFY/SOLVED when required problem evidence was stripped or substituted", () => {
  let state = findProblem(base(), "P-solved-evidence");
  state = solveAttempt(state);
  state = verify(state, "SOLVED");
  assert.doesNotThrow(() => validateEphemeralReasoningState(state));

  const empty = structuredClone(state);
  empty.last_result.evidence_refs = [];
  assert.throws(() => validateEphemeralReasoningState(empty), /restart VERIFY\/SOLVED|restart SOLVED|requires deterministic evidence/);

  const substituted = structuredClone(state);
  substituted.last_result.evidence_refs = ["ev:verify"];
  assert.throws(() => validateEphemeralReasoningState(substituted), /restart SOLVED missing required deterministic evidence/);
});

test("restart rejects GOAL_CHECK/COMPLETE when required goal evidence was stripped or substituted", () => {
  let state = findProblem(base(), "P-complete-evidence");
  state = solveAttempt(state);
  state = verify(state, "SOLVED");
  const goalEpisode = open(state);
  state = applyEphemeralReasoningResult(state, goalEpisode, result(goalEpisode, "COMPLETE", { evidence_refs: ["ev:goal"] }));
  assert.doesNotThrow(() => validateEphemeralReasoningState(state));

  const empty = structuredClone(state);
  empty.last_result.evidence_refs = [];
  assert.throws(() => validateEphemeralReasoningState(empty), /restart GOAL_CHECK\/COMPLETE|restart COMPLETE|requires deterministic evidence/);

  const substituted = structuredClone(state);
  substituted.last_result.evidence_refs = ["ev:verify"];
  assert.throws(() => validateEphemeralReasoningState(substituted), /restart COMPLETE missing required deterministic evidence/);
});

test("restart preserves canonical non-empty evidence gates for VERIFY/UNSOLVED and GOAL_CHECK/INCOMPLETE", () => {
  let unsolved = findProblem(base(), "P-unsolved-evidence");
  unsolved = solveAttempt(unsolved);
  unsolved = verify(unsolved, "UNSOLVED");
  const strippedUnsolved = structuredClone(unsolved);
  strippedUnsolved.last_result.evidence_refs = [];
  assert.throws(() => validateEphemeralReasoningState(strippedUnsolved), /restart VERIFY\/UNSOLVED requires deterministic evidence/);

  let incomplete = findProblem(base(), "P-incomplete-evidence");
  incomplete = solveAttempt(incomplete);
  incomplete = verify(incomplete, "SOLVED");
  const goalEpisode = open(incomplete);
  incomplete = applyEphemeralReasoningResult(incomplete, goalEpisode, result(goalEpisode, "INCOMPLETE", { evidence_refs: ["ev:goal"] }));
  const strippedIncomplete = structuredClone(incomplete);
  strippedIncomplete.last_result.evidence_refs = [];
  assert.throws(() => validateEphemeralReasoningState(strippedIncomplete), /restart GOAL_CHECK\/INCOMPLETE requires deterministic evidence/);
});