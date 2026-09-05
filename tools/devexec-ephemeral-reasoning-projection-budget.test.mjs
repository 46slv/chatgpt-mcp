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

function solvedHistoryBase() {
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

test("large solved provenance stays parent-owned while FIND and GOAL_CHECK keep exact live authority", () => {
  let state = solvedHistoryBase();

  for (let index = 0; index < PROBLEM_COUNT; index += 1) {
    state = solveOne(state, index);
    assert.equal(state.next_role, "GOAL_CHECK");
    assert.equal(state.solved_problem_receipts.length, index + 1);
    assert.doesNotThrow(() => validateEphemeralReasoningState(state));

    const goalEpisode = open(state);
    assert.equal(goalEpisode.role, "GOAL_CHECK");
    assert.deepEqual(goalEpisode.input.goal, state.goal);
    assert.deepEqual(goalEpisode.input.verified_facts, state.verified_facts);
    assert.deepEqual(goalEpisode.input.current_problem, state.current_problem);
    assert.equal(goalEpisode.input.solved_progress.count, index + 1);
    assert.equal(goalEpisode.input.solved_progress.digest.length, 64);
    assert.deepEqual(goalEpisode.input.solved_progress.recent_problem_ids, state.solved_problem_ids.slice(-8));
    assert.equal("solved_problem_receipts" in goalEpisode.input, false);
    assert.equal("solved_problem_ids" in goalEpisode.input, false);
    assert.equal("projection_compaction" in goalEpisode.input, false);
    assert.ok(goalEpisode.input_bytes < 16 * 1024);

    if (index < PROBLEM_COUNT - 1) state = markIncomplete(state);
  }

  assert.ok(Buffer.byteLength(JSON.stringify(state), "utf8") > 64 * 1024);
  state = markIncomplete(state);
  assert.equal(state.next_role, "FIND");
  assert.equal(state.current_problem, null);
  assert.equal(state.solved_problem_receipts.length, PROBLEM_COUNT);

  const findEpisode = open(state);
  assert.equal(findEpisode.role, "FIND");
  assert.deepEqual(findEpisode.input.goal, state.goal);
  assert.deepEqual(findEpisode.input.constraints, state.constraints);
  assert.deepEqual(findEpisode.input.verified_facts, state.verified_facts);
  assert.equal(findEpisode.input.solved_progress.count, PROBLEM_COUNT);
  assert.equal(findEpisode.input.solved_progress.digest.length, 64);
  assert.deepEqual(findEpisode.input.solved_progress.recent_problem_ids, state.solved_problem_ids.slice(-8));
  assert.equal("solved_problem_receipts" in findEpisode.input, false);
  assert.equal("solved_problem_ids" in findEpisode.input, false);
  assert.equal("projection_compaction" in findEpisode.input, false);
  assert.ok(findEpisode.input_bytes < 16 * 1024);
});

function maxItem(prefix, index) {
  const head = `${prefix}-${String(index).padStart(2, "0")}-`;
  return `${head}${"z".repeat((2 * 1024) - head.length)}`;
}

function oversizedAuthorityBase() {
  const factEvidence = Array.from({ length: 4 }, (_, index) => `ev:f${index}`);
  return createEphemeralReasoningState({
    mission_id: "M-DEV-LER-SEMANTIC-CORE-BUDGET",
    goal_id: "DEV-LER-001",
    goal: {
      text: "g".repeat(8 * 1024),
      acceptance: Array.from({ length: 4 }, (_, index) => maxItem("accept", index)),
      required_evidence_refs: ["ev:goal"],
    },
    constraints: Array.from({ length: 4 }, (_, index) => maxItem("constraint", index)),
    verified_facts: factEvidence.map((evidence_ref, index) => ({
      key: `fact-${index}`,
      value: "f".repeat(2 * 1024),
      evidence_ref,
    })),
    evidence_authority_refs: ["ev:goal", ...factEvidence],
    approved_context_refs: [],
  });
}

test("authority-bearing role input never becomes lossy or digest-only to satisfy a smaller budget", () => {
  const state = oversizedAuthorityBase();
  assert.doesNotThrow(() => validateEphemeralReasoningState(state));

  assert.throws(
    () => open(state),
    /mandatory FIND semantic core exceeds episode input budget/,
  );
  assert.throws(
    () => open(state, { max_input_bytes: 256 }),
    /mandatory FIND semantic core exceeds episode input budget/,
  );

  const roomy = open(state, { max_input_bytes: 64 * 1024 });
  assert.equal(roomy.role, "FIND");
  assert.deepEqual(roomy.input.goal, state.goal);
  assert.deepEqual(roomy.input.constraints, state.constraints);
  assert.deepEqual(roomy.input.verified_facts, state.verified_facts);
  assert.equal("projection_compaction" in roomy.input, false);
});

function semanticBase() {
  return createEphemeralReasoningState({
    mission_id: "M-DEV-LER-SEMANTIC-IDENTITY",
    goal_id: "DEV-LER-001",
    goal: {
      text: "Preserve the exact semantic authority visible to every reasoning role",
      acceptance: ["protected role inputs are byte-for-byte exact", "tampering cannot promote authority"],
      required_evidence_refs: ["ev:goal"],
    },
    constraints: ["constraint:immutable", "constraint:evidence-bound"],
    verified_facts: [{ key: "fact-a", value: "verified", evidence_ref: "ev:fact" }],
    evidence_authority_refs: ["ev:goal", "ev:fact", "ev:problem"],
    approved_context_refs: [],
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("every opened role preserves its required semantic core byte-for-byte and altered core cannot transition", () => {
  let state = semanticBase();

  let episode = open(state);
  assert.equal(episode.role, "FIND");
  assert.deepEqual(episode.input.goal, state.goal);
  assert.deepEqual(episode.input.constraints, state.constraints);
  assert.deepEqual(episode.input.verified_facts, state.verified_facts);
  const forgedFind = clone(episode);
  forgedFind.input.goal.acceptance[0] = "forged acceptance";
  assert.throws(
    () => applyEphemeralReasoningResult(state, forgedFind, result(forgedFind, "FOUND", {
      problem: { problem_id: "P-semantic", statement: "work", required_evidence_refs: ["ev:problem"] },
    })),
    /episode role projection mismatch/,
  );
  state = applyEphemeralReasoningResult(state, episode, result(episode, "FOUND", {
    problem: { problem_id: "P-semantic", statement: "work", required_evidence_refs: ["ev:problem"] },
  }));

  episode = open(state);
  assert.equal(episode.role, "SOLVE");
  assert.deepEqual(episode.input.problem, state.current_problem);
  assert.deepEqual(episode.input.constraints, state.constraints);
  const forgedSolve = clone(episode);
  forgedSolve.input.constraints = [];
  assert.throws(
    () => applyEphemeralReasoningResult(state, forgedSolve, result(forgedSolve, "ATTEMPTED")),
    /episode role projection mismatch/,
  );
  state = applyEphemeralReasoningResult(state, episode, result(episode, "ATTEMPTED"));

  episode = open(state);
  assert.equal(episode.role, "VERIFY");
  assert.deepEqual(episode.input.problem, state.current_problem);
  assert.deepEqual(episode.input.attempt, state.attempts[state.attempts.length - 1]);
  const forgedVerify = clone(episode);
  forgedVerify.input.problem.statement = "forged work";
  assert.throws(
    () => applyEphemeralReasoningResult(state, forgedVerify, result(forgedVerify, "SOLVED", {
      evidence_refs: ["ev:problem"],
    })),
    /episode role projection mismatch/,
  );
  assert.equal(state.solved_problem_ids.length, 0);
  state = applyEphemeralReasoningResult(state, episode, result(episode, "SOLVED", {
    evidence_refs: ["ev:problem"],
  }));

  episode = open(state);
  assert.equal(episode.role, "GOAL_CHECK");
  assert.deepEqual(episode.input.goal, state.goal);
  assert.deepEqual(episode.input.verified_facts, state.verified_facts);
  assert.deepEqual(episode.input.current_problem, state.current_problem);
  assert.deepEqual(episode.input.last_result, state.last_result);
  const forgedGoalCheck = clone(episode);
  forgedGoalCheck.input.goal.acceptance = [];
  assert.throws(
    () => applyEphemeralReasoningResult(state, forgedGoalCheck, result(forgedGoalCheck, "COMPLETE", {
      evidence_refs: ["ev:goal"],
    })),
    /episode role projection mismatch/,
  );
  assert.equal(state.terminal, null);
  const completed = applyEphemeralReasoningResult(state, episode, result(episode, "COMPLETE", {
    evidence_refs: ["ev:goal"],
  }));
  assert.equal(completed.terminal, "COMPLETE");
  assert.equal(completed.next_role, "STOP");
});
