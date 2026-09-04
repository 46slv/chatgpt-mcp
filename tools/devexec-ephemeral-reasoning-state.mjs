import crypto from "node:crypto";

export const EPHEMERAL_REASONING_STATE_SCHEMA = "devexec.ephemeral-reasoning-state/v1";
export const EPHEMERAL_REASONING_EPISODE_SCHEMA = "devexec.ephemeral-reasoning-episode/v1";
export const EPHEMERAL_REASONING_RESULT_SCHEMA = "devexec.ephemeral-reasoning-result/v1";

const ROLES = new Set(["FIND", "SOLVE", "VERIFY", "GOAL_CHECK"]);
const NEXT_ROLES = new Set([...ROLES, "STOP", "ESCALATE"]);
const OUTCOMES = Object.freeze({
  FIND: new Set(["FOUND", "BLOCKED"]),
  SOLVE: new Set(["ATTEMPTED", "NEEDS_CONTEXT", "BLOCKED"]),
  VERIFY: new Set(["SOLVED", "UNSOLVED", "BLOCKED"]),
  GOAL_CHECK: new Set(["COMPLETE", "INCOMPLETE", "BLOCKED"]),
});
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const FORBIDDEN_KEYS = new Set([
  "transcript", "transcripts", "conversation", "conversations", "history", "messages",
  "tool_history", "reasoning", "chain_of_thought", "raw_prompt", "raw_response",
]);
const LIMITS = Object.freeze({
  goal_text: 16 * 1024,
  summary: 4 * 1024,
  statement: 8 * 1024,
  item: 2 * 1024,
  ref: 1024,
  list: 128,
  facts: 128,
  attempts: 128,
  durable_state_bytes: 256 * 1024,
  episode_input_bytes: 64 * 1024,
  episode_output_bytes: 32 * 1024,
});

function isObject(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
function exact(value, keys, name) {
  if (!isObject(value)) throw new Error(`${name} must be an object`);
  const got = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (got.length !== expected.length || got.some((key, index) => key !== expected[index])) {
    throw new Error(`${name} has unknown or missing keys`);
  }
}
function text(value, name, max, { empty = false } = {}) {
  if (typeof value !== "string" || (!empty && !value.trim()) || Buffer.byteLength(value, "utf8") > max) {
    throw new Error(`${name} invalid`);
  }
  return value;
}
function id(value, name) {
  if (typeof value !== "string" || !ID_RE.test(value)) throw new Error(`${name} invalid`);
  return value;
}
function ref(value, name) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > LIMITS.ref || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${name} invalid`);
  }
  return value;
}
function uniqueStrings(values, name, validator = ref, max = LIMITS.list) {
  if (!Array.isArray(values) || values.length > max) throw new Error(`${name} invalid`);
  const out = values.map((value, index) => validator(value, `${name}[${index}]`));
  if (new Set(out).size !== out.length) throw new Error(`${name} must be unique`);
  return out;
}
function itemList(values, name) {
  return uniqueStrings(values, name, (value, itemName) => text(value, itemName, LIMITS.item), LIMITS.list);
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function sha256(value) { return crypto.createHash("sha256").update(typeof value === "string" ? value : canonical(value), "utf8").digest("hex"); }
function rejectForbiddenKeys(value, path = "value") {
  if (Array.isArray(value)) return value.forEach((item, index) => rejectForbiddenKeys(item, `${path}[${index}]`));
  if (!isObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) throw new Error(`${path}.${key} is forbidden durable/reasoning memory`);
    rejectForbiddenKeys(item, `${path}.${key}`);
  }
}
function assertBytes(value, max, name) {
  const bytes = Buffer.byteLength(canonical(value), "utf8");
  if (bytes > max) throw new Error(`${name} exceeds byte budget`);
  return bytes;
}
function problem(value, name = "problem") {
  exact(value, ["problem_id", "statement", "required_evidence_refs"], name);
  return {
    problem_id: id(value.problem_id, `${name}.problem_id`),
    statement: text(value.statement, `${name}.statement`, LIMITS.statement),
    required_evidence_refs: uniqueStrings(value.required_evidence_refs, `${name}.required_evidence_refs`),
  };
}
function fact(value, name) {
  exact(value, ["key", "value", "evidence_ref"], name);
  return {
    key: id(value.key, `${name}.key`),
    value: text(value.value, `${name}.value`, LIMITS.item, { empty: true }),
    evidence_ref: ref(value.evidence_ref, `${name}.evidence_ref`),
  };
}
function facts(values, name = "verified_facts") {
  if (!Array.isArray(values) || values.length > LIMITS.facts) throw new Error(`${name} invalid`);
  const out = values.map((value, index) => fact(value, `${name}[${index}]`));
  if (new Set(out.map((entry) => entry.key)).size !== out.length) throw new Error(`${name} keys must be unique`);
  return out;
}
function attempt(value, name) {
  exact(value, ["episode_id", "problem_id", "outcome", "summary", "evidence_refs", "requested_context_refs"], name);
  id(value.episode_id, `${name}.episode_id`);
  id(value.problem_id, `${name}.problem_id`);
  if (!["ATTEMPTED", "NEEDS_CONTEXT"].includes(value.outcome)) throw new Error(`${name}.outcome invalid`);
  text(value.summary, `${name}.summary`, LIMITS.summary);
  uniqueStrings(value.evidence_refs, `${name}.evidence_refs`);
  uniqueStrings(value.requested_context_refs, `${name}.requested_context_refs`);
  return clone(value);
}
function validateGoal(value) {
  exact(value, ["text", "acceptance", "required_evidence_refs"], "goal");
  return {
    text: text(value.text, "goal.text", LIMITS.goal_text),
    acceptance: itemList(value.acceptance, "goal.acceptance"),
    required_evidence_refs: uniqueStrings(value.required_evidence_refs, "goal.required_evidence_refs"),
  };
}

const STATE_KEYS = [
  "schema", "schema_version", "mission_id", "goal_id", "goal", "constraints", "verified_facts",
  "approved_context_refs", "pending_context_request_refs", "current_problem", "solved_problem_ids",
  "attempts", "episode_seq", "next_role", "terminal", "last_result",
];
const LAST_RESULT_KEYS = ["episode_id", "role", "outcome", "summary", "evidence_refs"];

export function validateEphemeralReasoningState(state) {
  rejectForbiddenKeys(state, "state");
  exact(state, STATE_KEYS, "ephemeral reasoning state");
  if (state.schema !== EPHEMERAL_REASONING_STATE_SCHEMA || state.schema_version !== 1) throw new Error("unsupported ephemeral reasoning state schema");
  id(state.mission_id, "mission_id"); id(state.goal_id, "goal_id"); validateGoal(state.goal);
  itemList(state.constraints, "constraints"); facts(state.verified_facts);
  uniqueStrings(state.approved_context_refs, "approved_context_refs");
  uniqueStrings(state.pending_context_request_refs, "pending_context_request_refs");
  if (state.current_problem !== null) problem(state.current_problem, "current_problem");
  uniqueStrings(state.solved_problem_ids, "solved_problem_ids", id);
  if (!Array.isArray(state.attempts) || state.attempts.length > LIMITS.attempts) throw new Error("attempts invalid");
  state.attempts.forEach((entry, index) => attempt(entry, `attempts[${index}]`));
  if (!Number.isInteger(state.episode_seq) || state.episode_seq < 0 || state.episode_seq > 1_000_000) throw new Error("episode_seq invalid");
  if (!NEXT_ROLES.has(state.next_role)) throw new Error("next_role invalid");
  if (state.terminal !== null && !["COMPLETE", "BLOCKED"].includes(state.terminal)) throw new Error("terminal invalid");
  if (state.terminal === "COMPLETE" && state.next_role !== "STOP") throw new Error("COMPLETE state must STOP");
  if (state.terminal === "BLOCKED" && state.next_role !== "ESCALATE") throw new Error("BLOCKED state must ESCALATE");
  if (state.terminal === null && !ROLES.has(state.next_role)) throw new Error("non-terminal state requires reasoning role");
  if (["SOLVE", "VERIFY"].includes(state.next_role) && state.current_problem === null) throw new Error(`${state.next_role} requires current_problem`);
  if (state.last_result !== null) {
    exact(state.last_result, LAST_RESULT_KEYS, "last_result");
    id(state.last_result.episode_id, "last_result.episode_id");
    if (!ROLES.has(state.last_result.role)) throw new Error("last_result.role invalid");
    if (!OUTCOMES[state.last_result.role].has(state.last_result.outcome)) throw new Error("last_result.outcome invalid");
    text(state.last_result.summary, "last_result.summary", LIMITS.summary);
    uniqueStrings(state.last_result.evidence_refs, "last_result.evidence_refs");
  }
  assertBytes(state, LIMITS.durable_state_bytes, "durable reasoning state");
  return state;
}

export function createEphemeralReasoningState({ mission_id, goal_id, goal, constraints = [], verified_facts = [], approved_context_refs = [] } = {}) {
  const state = {
    schema: EPHEMERAL_REASONING_STATE_SCHEMA,
    schema_version: 1,
    mission_id: id(mission_id, "mission_id"),
    goal_id: id(goal_id, "goal_id"),
    goal: validateGoal(goal),
    constraints: itemList(constraints, "constraints"),
    verified_facts: facts(verified_facts),
    approved_context_refs: uniqueStrings(approved_context_refs, "approved_context_refs"),
    pending_context_request_refs: [],
    current_problem: null,
    solved_problem_ids: [],
    attempts: [],
    episode_seq: 0,
    next_role: "FIND",
    terminal: null,
    last_result: null,
  };
  validateEphemeralReasoningState(state);
  return state;
}

function latestAttemptFor(state, problemId) {
  for (let index = state.attempts.length - 1; index >= 0; index -= 1) {
    if (state.attempts[index].problem_id === problemId) return clone(state.attempts[index]);
  }
  return null;
}
function roleProjection(state) {
  if (state.next_role === "FIND") return {
    goal: clone(state.goal), constraints: clone(state.constraints), verified_facts: clone(state.verified_facts), solved_problem_ids: clone(state.solved_problem_ids),
  };
  if (state.next_role === "SOLVE") return {
    problem: clone(state.current_problem), constraints: clone(state.constraints), prior_attempt: latestAttemptFor(state, state.current_problem.problem_id),
  };
  if (state.next_role === "VERIFY") return {
    problem: clone(state.current_problem), attempt: latestAttemptFor(state, state.current_problem.problem_id),
  };
  if (state.next_role === "GOAL_CHECK") return {
    goal: clone(state.goal), verified_facts: clone(state.verified_facts), solved_problem_ids: clone(state.solved_problem_ids), last_result: clone(state.last_result),
  };
  throw new Error("terminal state cannot open reasoning episode");
}
function workingSet(values, approved) {
  if (!Array.isArray(values) || values.length > 32) throw new Error("working_set invalid");
  const allowed = new Set(approved);
  return values.map((entry, index) => {
    const name = `working_set[${index}]`;
    exact(entry, ["ref", "kind", "sha256", "content"], name);
    const entryRef = ref(entry.ref, `${name}.ref`);
    if (!allowed.has(entryRef)) throw new Error(`${name}.ref is not approved by parent state`);
    const kind = id(entry.kind, `${name}.kind`);
    if (typeof entry.sha256 !== "string" || !HEX64.test(entry.sha256)) throw new Error(`${name}.sha256 invalid`);
    const content = text(entry.content, `${name}.content`, LIMITS.episode_input_bytes, { empty: true });
    if (sha256(content) !== entry.sha256) throw new Error(`${name}.sha256 mismatch`);
    return { ref: entryRef, kind, sha256: entry.sha256, content };
  });
}

export function openEphemeralReasoningEpisode(state, { working_set = [], max_input_bytes = 16 * 1024, max_output_bytes = 8 * 1024 } = {}) {
  validateEphemeralReasoningState(state);
  if (state.pending_context_request_refs.length) throw new Error("pending context request requires parent resolution before fresh episode");
  if (!ROLES.has(state.next_role)) throw new Error("terminal state cannot open reasoning episode");
  if (!Number.isInteger(max_input_bytes) || max_input_bytes < 256 || max_input_bytes > LIMITS.episode_input_bytes) throw new Error("max_input_bytes invalid");
  if (!Number.isInteger(max_output_bytes) || max_output_bytes < 128 || max_output_bytes > LIMITS.episode_output_bytes) throw new Error("max_output_bytes invalid");
  const state_digest = sha256(state);
  const episode_id = expectedEpisodeId(state, state_digest);
  const episode = {
    schema: EPHEMERAL_REASONING_EPISODE_SCHEMA,
    schema_version: 1,
    episode_id,
    sequence: state.episode_seq + 1,
    role: state.next_role,
    state_digest,
    session_policy: "FRESH_CONTEXT_REQUIRED",
    forward_transcript: false,
    input: roleProjection(state),
    working_set: workingSet(working_set, state.approved_context_refs),
    budgets: { max_input_bytes, max_output_bytes },
  };
  rejectForbiddenKeys(episode, "episode");
  const input_bytes = assertBytes({ input: episode.input, working_set: episode.working_set }, max_input_bytes, "episode input");
  return { ...episode, input_bytes };
}

const EPISODE_KEYS = ["schema", "schema_version", "episode_id", "sequence", "role", "state_digest", "session_policy", "forward_transcript", "input", "working_set", "budgets", "input_bytes"];
function expectedEpisodeId(state, stateDigest = sha256(state)) {
  return `E${String(state.episode_seq + 1).padStart(6, "0")}-${sha256(`${state.mission_id}:${state.goal_id}:${state.episode_seq}:${state.next_role}:${stateDigest}`).slice(0, 16)}`;
}
function validateEpisodeAgainstState(episode, state) {
  rejectForbiddenKeys(episode, "episode");
  exact(episode, EPISODE_KEYS, "ephemeral reasoning episode");
  if (episode.schema !== EPHEMERAL_REASONING_EPISODE_SCHEMA || episode.schema_version !== 1) throw new Error("unsupported ephemeral reasoning episode schema");
  const stateDigest = sha256(state);
  if (episode.state_digest !== stateDigest || episode.sequence !== state.episode_seq + 1 || episode.role !== state.next_role || episode.episode_id !== expectedEpisodeId(state, stateDigest)) throw new Error("stale or mismatched episode");
  if (episode.session_policy !== "FRESH_CONTEXT_REQUIRED" || episode.forward_transcript !== false) throw new Error("episode freshness policy invalid");
  exact(episode.budgets, ["max_input_bytes", "max_output_bytes"], "episode.budgets");
  const { max_input_bytes, max_output_bytes } = episode.budgets;
  if (!Number.isInteger(max_input_bytes) || max_input_bytes < 256 || max_input_bytes > LIMITS.episode_input_bytes) throw new Error("episode max_input_bytes invalid");
  if (!Number.isInteger(max_output_bytes) || max_output_bytes < 128 || max_output_bytes > LIMITS.episode_output_bytes) throw new Error("episode max_output_bytes invalid");
  if (canonical(episode.input) !== canonical(roleProjection(state))) throw new Error("episode role projection mismatch");
  const checkedWorkingSet = workingSet(episode.working_set, state.approved_context_refs);
  if (canonical(checkedWorkingSet) !== canonical(episode.working_set)) throw new Error("episode working set mismatch");
  const inputBytes = assertBytes({ input: episode.input, working_set: checkedWorkingSet }, max_input_bytes, "episode input");
  if (!Number.isInteger(episode.input_bytes) || episode.input_bytes !== inputBytes) throw new Error("episode input_bytes mismatch");
  return episode;
}

const RESULT_KEYS = ["schema", "schema_version", "episode_id", "role", "outcome", "summary", "evidence_refs", "problem", "context_request_refs", "verified_facts"];
function validateResult(result, episode) {
  rejectForbiddenKeys(result, "result");
  exact(result, RESULT_KEYS, "ephemeral reasoning result");
  if (result.schema !== EPHEMERAL_REASONING_RESULT_SCHEMA || result.schema_version !== 1) throw new Error("unsupported ephemeral reasoning result schema");
  if (result.episode_id !== episode.episode_id || result.role !== episode.role) throw new Error("result episode identity mismatch");
  if (!OUTCOMES[episode.role].has(result.outcome)) throw new Error(`outcome invalid for ${episode.role}`);
  text(result.summary, "result.summary", LIMITS.summary);
  uniqueStrings(result.evidence_refs, "result.evidence_refs");
  uniqueStrings(result.context_request_refs, "result.context_request_refs");
  facts(result.verified_facts, "result.verified_facts");
  if (result.problem !== null) problem(result.problem, "result.problem");
  if (episode.role === "FIND" && result.outcome === "FOUND" && result.problem === null) throw new Error("FOUND requires problem");
  if (!(episode.role === "FIND" && result.outcome === "FOUND") && result.problem !== null) throw new Error("problem is only valid for FIND/FOUND");
  if (!(episode.role === "SOLVE" && result.outcome === "NEEDS_CONTEXT") && result.context_request_refs.length) throw new Error("context_request_refs only valid for SOLVE/NEEDS_CONTEXT");
  if (episode.role === "SOLVE" && result.outcome === "NEEDS_CONTEXT" && !result.context_request_refs.length) throw new Error("NEEDS_CONTEXT requires requested refs");
  if (["FIND", "SOLVE"].includes(episode.role) && result.verified_facts.length) throw new Error(`${episode.role} cannot promote verified facts`);
  for (const entry of result.verified_facts) if (!result.evidence_refs.includes(entry.evidence_ref)) throw new Error("verified fact evidence must be present in result evidence_refs");
  assertBytes(result, episode.budgets.max_output_bytes, "episode result");
  return result;
}
function requireEvidence(required, supplied, name) {
  if (!supplied.length) throw new Error(`${name} requires deterministic evidence`);
  const set = new Set(supplied);
  const missing = required.filter((item) => !set.has(item));
  if (missing.length) throw new Error(`${name} missing required deterministic evidence: ${missing.join(",")}`);
}
function mergeFacts(existing, incoming) {
  const byKey = new Map(existing.map((entry) => [entry.key, clone(entry)]));
  for (const entry of incoming) byKey.set(entry.key, clone(entry));
  const out = [...byKey.values()];
  if (out.length > LIMITS.facts) throw new Error("verified facts limit exceeded");
  return out;
}

export function applyEphemeralReasoningResult(state, episode, result) {
  validateEphemeralReasoningState(state);
  validateEpisodeAgainstState(episode, state);
  validateResult(result, episode);
  const next = clone(state);
  next.episode_seq = episode.sequence;
  next.last_result = { episode_id: result.episode_id, role: result.role, outcome: result.outcome, summary: result.summary, evidence_refs: clone(result.evidence_refs) };
  next.verified_facts = mergeFacts(next.verified_facts, result.verified_facts);

  if (episode.role === "FIND") {
    if (result.outcome === "BLOCKED") { next.terminal = "BLOCKED"; next.next_role = "ESCALATE"; }
    else {
      const found = problem(result.problem, "result.problem");
      if (next.solved_problem_ids.includes(found.problem_id)) throw new Error("FIND cannot reopen solved problem id");
      next.current_problem = found; next.next_role = "SOLVE";
    }
  } else if (episode.role === "SOLVE") {
    if (result.outcome === "BLOCKED") { next.terminal = "BLOCKED"; next.next_role = "ESCALATE"; }
    else {
      const record = { episode_id: episode.episode_id, problem_id: next.current_problem.problem_id, outcome: result.outcome, summary: result.summary, evidence_refs: clone(result.evidence_refs), requested_context_refs: clone(result.context_request_refs) };
      next.attempts.push(record);
      if (next.attempts.length > LIMITS.attempts) throw new Error("attempt limit exceeded");
      if (result.outcome === "NEEDS_CONTEXT") {
        next.pending_context_request_refs = clone(result.context_request_refs);
        next.next_role = "SOLVE";
      } else next.next_role = "VERIFY";
    }
  } else if (episode.role === "VERIFY") {
    if (result.outcome === "BLOCKED") { next.terminal = "BLOCKED"; next.next_role = "ESCALATE"; }
    else if (result.outcome === "UNSOLVED") next.next_role = "SOLVE";
    else {
      requireEvidence(next.current_problem.required_evidence_refs, result.evidence_refs, "SOLVED");
      if (!next.solved_problem_ids.includes(next.current_problem.problem_id)) next.solved_problem_ids.push(next.current_problem.problem_id);
      next.next_role = "GOAL_CHECK";
    }
  } else if (episode.role === "GOAL_CHECK") {
    if (result.outcome === "BLOCKED") { next.terminal = "BLOCKED"; next.next_role = "ESCALATE"; }
    else if (result.outcome === "INCOMPLETE") { next.current_problem = null; next.next_role = "FIND"; }
    else {
      requireEvidence(next.goal.required_evidence_refs, result.evidence_refs, "COMPLETE");
      next.terminal = "COMPLETE"; next.next_role = "STOP";
    }
  }
  validateEphemeralReasoningState(next);
  return next;
}

export function resolveEphemeralContextRequest(state, { approved_refs = [] } = {}) {
  validateEphemeralReasoningState(state);
  if (!state.pending_context_request_refs.length) throw new Error("no pending context request");
  const approved = uniqueStrings(approved_refs, "approved_refs");
  const requested = new Set(state.pending_context_request_refs);
  for (const item of approved) if (!requested.has(item)) throw new Error("parent cannot approve unrequested context through this transition");
  const next = clone(state);
  next.approved_context_refs = [...new Set([...next.approved_context_refs, ...approved])];
  next.pending_context_request_refs = [];
  validateEphemeralReasoningState(next);
  return next;
}

export function ephemeralReasoningStateDigest(state) {
  validateEphemeralReasoningState(state);
  return sha256(state);
}
