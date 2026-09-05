import test from "node:test";
import assert from "node:assert/strict";
import {
  EPHEMERAL_REASONING_RESULT_SCHEMA,
  createEphemeralReasoningState,
  validateEphemeralReasoningState,
  openEphemeralReasoningEpisode,
  applyEphemeralReasoningResult,
} from "./devexec-ephemeral-reasoning-state.mjs";

const PROBLEM_COUNT = 16;
const MAX_STATEMENT = "x".repeat(8 * 1024);
const problemEvidence = Array.from({ length: PROBLEM_COUNT }, (_, index) => `ev:p${index}`);

function result(episode, outcome, overrides = {}) {
  return {
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
  };
}

function open(state, overrides = {}) {
  return openEphemeralReasoningEpisode(state, {
    max_input_bytes: 16 * 1024,
    max_output_bytes: 32 * 1024,
    ...overrides,
  });
}

function solveOne(state, index) {
  const problemId = `P-large-${String(index).padStart(2, "0")}`;
  const evidenceRef = problemEvidence[index];

  let episode = open(state);
  state = applyEphemeralReasoningResult(state, episode, result(episode, "FOUND", {
    problem: { problem_id: problemId, statement: MAX_STATEMENT, required_evidence_refs: [evidenceRef] },
  }));

  episode = open(state);
  state = applyEphemeralReasoningResult(state, episode, result(episode, "ATTEMPTED"));

  episode = open(state);
  state = applyEphemeralReasoningResult(state, episode, result(episode, "SOLVED", {
    evidence_refs: [evidenceRef],
  }));
  return state;
}

function markIncomplete(state) {
  const episode = open(state);
  return applyEphemeralReasoningResult(state, episode, result(episode, "INCOMPLETE", {
    evidence_refs: ["ev:goal"],
  }));
}

function base() {
  return createEphemeralReasoningState({
    mission_id: "M-DEV-LER-PROJECTION-BUDGET",
    goal_id: "DEV-LER-001",
    goal: {
      text: "Keep durable solved provenance outside the fresh model context budget",
      acceptance: ["many solved problems do not grow FIND or GOAL_CHECK input without bound"],
      required_evidence_refs: ["ev:goal"],
    },
    constraints: ["fresh context per episode"],
    evidence_authority_refs: ["ev:goal", ...problemEvidence],
    approved_context_refs: [],
  });
}

test("many large durable solved receipts stay out of fixed-budget FIND and GOAL_CHECK projections", () => {
  let state = base();

  for (let index = 0; index < PROBLEM_COUNT; index += 1) {
    state = solveOne(state, index);
    assert.equal(state.next_role, "GOAL_CHECK");
    assert.equal(state.solved_problem_receipts.length, index + 1);
    assert.doesNotThrow(() => validateEphemeralReasoningState(state));

    const goalEpisode = open(state);
    assert.equal(goalEpisode.role, "GOAL_CHECK");
    assert.equal(goalEpisode.input.solved_progress.count, index + 1);
    assert.equal(goalEpisode.input.solved_progress.digest.length, 64);
    assert.deepEqual(
      goalEpisode.input.solved_progress.recent_problem_ids,
      state.solved_problem_ids.slice(-8),
    );
    assert.equal(goalEpisode.input.current_problem.problem_id, state.current_problem.problem_id);
    assert.equal("solved_problem_receipts" in goalEpisode.input, false);
    assert.equal("solved_problem_ids" in goalEpisode.input, false);
    assert.ok(goalEpisode.input_bytes < 16 * 1024);

    if (index < PROBLEM_COUNT - 1) state = markIncomplete(state);
  }

  assert.ok(Buffer.byteLength(JSON.stringify(state), "utf8") > 64 * 1024);
  assert.doesNotThrow(() => open(state, { max_input_bytes: 64 * 1024 }));

  state = markIncomplete(state);
  assert.equal(state.next_role, "FIND");
  assert.equal(state.current_problem, null);
  assert.equal(state.solved_problem_receipts.length, PROBLEM_COUNT);
  assert.ok(Buffer.byteLength(JSON.stringify(state), "utf8") > 64 * 1024);

  const findEpisode = open(state);
  assert.equal(findEpisode.role, "FIND");
  assert.equal(findEpisode.input.solved_progress.count, PROBLEM_COUNT);
  assert.equal(findEpisode.input.solved_progress.digest.length, 64);
  assert.deepEqual(findEpisode.input.solved_progress.recent_problem_ids, state.solved_problem_ids.slice(-8));
  assert.equal("solved_problem_receipts" in findEpisode.input, false);
  assert.equal("solved_problem_ids" in findEpisode.input, false);
  assert.ok(findEpisode.input_bytes < 16 * 1024);
  assert.doesNotThrow(() => open(state, { max_input_bytes: 64 * 1024 }));
});
