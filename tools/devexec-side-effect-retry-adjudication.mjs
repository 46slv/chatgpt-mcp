import crypto from "node:crypto";

export const SIDE_EFFECT_RETRY_ADJUDICATION_PROTOCOL = "devexec.side-effect-retry-adjudication";
export const SIDE_EFFECT_RETRY_ADJUDICATION_SCHEMA_VERSION = 1;

const MAX_TEXT = 1024;
const HEX64 = /^[a-f0-9]{64}$/;
const PRIOR_STATUSES = new Set(["PREPARED", "IN_FLIGHT", "SUCCEEDED", "FAILED", "AMBIGUOUS", "STOPPED"]);
const AUTHORITY_DECISIONS = new Set(["ALLOW_DISTINCT_RETRY", "DENY", "STOP"]);
const CONTRACT_DECISIONS = new Set(["ALLOW", "DENY"]);

const PRIOR_KEYS = Object.freeze([
  "fingerprint", "equivalence_key", "surface", "action_type", "target", "immutable_input",
  "status", "reason_code", "control_identity",
]);
const PROPOSED_KEYS = Object.freeze([
  "fingerprint", "equivalence_key", "surface", "action_type", "target", "immutable_input",
  "control_identity", "prior_attempt_id", "distinct_reason",
]);
const AUTHORITY_KEYS = Object.freeze([
  "identity", "decision", "supersedes_control_identity", "prior_fingerprint", "next_fingerprint",
  "equivalence_key", "retry_contract_identity",
]);
const CONTRACT_KEYS = Object.freeze([
  "identity", "decision", "surface", "action_type", "prior_status", "prior_reason_code",
]);

export class SideEffectRetryAdjudicationError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = "SideEffectRetryAdjudicationError";
    this.code = code;
  }
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  if (!isObject(value)) throw new SideEffectRetryAdjudicationError("SIDE_EFFECT_RETRY_INVALID", `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new SideEffectRetryAdjudicationError("SIDE_EFFECT_RETRY_INVALID", `${label} has unknown or missing keys`);
  }
}

function bounded(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new SideEffectRetryAdjudicationError("SIDE_EFFECT_RETRY_INVALID", `${label} is invalid`);
  }
  return value;
}

function hex64(value, label) {
  if (typeof value !== "string" || !HEX64.test(value)) {
    throw new SideEffectRetryAdjudicationError("SIDE_EFFECT_RETRY_INVALID", `${label} must be a lowercase sha256 digest`);
  }
  return value;
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function validatePrior(input) {
  exactKeys(input, PRIOR_KEYS, "prior");
  const status = bounded(input.status, "prior.status");
  if (!PRIOR_STATUSES.has(status)) throw new SideEffectRetryAdjudicationError("SIDE_EFFECT_RETRY_INVALID", "prior.status is unsupported");
  return {
    fingerprint: hex64(input.fingerprint, "prior.fingerprint"),
    equivalence_key: hex64(input.equivalence_key, "prior.equivalence_key"),
    surface: bounded(input.surface, "prior.surface"),
    action_type: bounded(input.action_type, "prior.action_type"),
    target: bounded(input.target, "prior.target"),
    immutable_input: bounded(input.immutable_input, "prior.immutable_input"),
    status,
    reason_code: bounded(input.reason_code, "prior.reason_code", { nullable: true }),
    control_identity: bounded(input.control_identity, "prior.control_identity"),
  };
}

function validateProposed(input) {
  exactKeys(input, PROPOSED_KEYS, "proposed");
  return {
    fingerprint: hex64(input.fingerprint, "proposed.fingerprint"),
    equivalence_key: hex64(input.equivalence_key, "proposed.equivalence_key"),
    surface: bounded(input.surface, "proposed.surface"),
    action_type: bounded(input.action_type, "proposed.action_type"),
    target: bounded(input.target, "proposed.target"),
    immutable_input: bounded(input.immutable_input, "proposed.immutable_input"),
    control_identity: bounded(input.control_identity, "proposed.control_identity"),
    prior_attempt_id: bounded(input.prior_attempt_id, "proposed.prior_attempt_id", { nullable: true }),
    distinct_reason: bounded(input.distinct_reason, "proposed.distinct_reason", { nullable: true }),
  };
}

function validateAuthority(input) {
  exactKeys(input, AUTHORITY_KEYS, "retry authority");
  const decision = bounded(input.decision, "retry authority.decision");
  if (!AUTHORITY_DECISIONS.has(decision)) throw new SideEffectRetryAdjudicationError("SIDE_EFFECT_RETRY_INVALID", "retry authority.decision is unsupported");
  return {
    identity: bounded(input.identity, "retry authority.identity"),
    decision,
    supersedes_control_identity: bounded(input.supersedes_control_identity, "retry authority.supersedes_control_identity"),
    prior_fingerprint: hex64(input.prior_fingerprint, "retry authority.prior_fingerprint"),
    next_fingerprint: hex64(input.next_fingerprint, "retry authority.next_fingerprint"),
    equivalence_key: hex64(input.equivalence_key, "retry authority.equivalence_key"),
    retry_contract_identity: bounded(input.retry_contract_identity, "retry authority.retry_contract_identity"),
  };
}

function validateRetryContract(input) {
  exactKeys(input, CONTRACT_KEYS, "retry contract");
  const decision = bounded(input.decision, "retry contract.decision");
  if (!CONTRACT_DECISIONS.has(decision)) throw new SideEffectRetryAdjudicationError("SIDE_EFFECT_RETRY_INVALID", "retry contract.decision is unsupported");
  const priorStatus = bounded(input.prior_status, "retry contract.prior_status");
  if (!PRIOR_STATUSES.has(priorStatus)) throw new SideEffectRetryAdjudicationError("SIDE_EFFECT_RETRY_INVALID", "retry contract.prior_status is unsupported");
  return {
    identity: bounded(input.identity, "retry contract.identity"),
    decision,
    surface: bounded(input.surface, "retry contract.surface"),
    action_type: bounded(input.action_type, "retry contract.action_type"),
    prior_status: priorStatus,
    prior_reason_code: bounded(input.prior_reason_code, "retry contract.prior_reason_code", { nullable: true }),
  };
}

function stop(reasonCode, prior = null) {
  return { decision: "STOP", reason_code: reasonCode, prior_fingerprint: prior?.fingerprint ?? null };
}

export async function adjudicateDistinctSideEffectRetry({
  prior: priorInput,
  proposed: proposedInput,
  readRetryAuthority,
  readRetryContract,
} = {}) {
  if (typeof readRetryAuthority !== "function" || typeof readRetryContract !== "function") {
    throw new SideEffectRetryAdjudicationError("SIDE_EFFECT_RETRY_INVALID", "retry authority and retry contract readers are required");
  }
  const prior = validatePrior(priorInput);
  const proposed = validateProposed(proposedInput);

  if (prior.status === "SUCCEEDED") return { decision: "DUPLICATE", reason_code: "SIDE_EFFECT_ALREADY_SUCCEEDED", prior_fingerprint: prior.fingerprint };
  if (prior.status !== "FAILED") return stop("PRIOR_OUTCOME_NOT_RETRYABLE", prior);
  if (proposed.equivalence_key !== prior.equivalence_key || proposed.surface !== prior.surface || proposed.action_type !== prior.action_type || proposed.target !== prior.target || proposed.immutable_input !== prior.immutable_input) {
    return stop("IMMUTABLE_ACTION_CHANGED", prior);
  }
  if (proposed.prior_attempt_id !== prior.fingerprint) return stop("PRIOR_ATTEMPT_MISMATCH", prior);
  if (proposed.distinct_reason === null) return stop("DISTINCT_REASON_REQUIRED", prior);
  if (proposed.fingerprint === prior.fingerprint) return stop("DISTINCT_FINGERPRINT_REQUIRED", prior);

  let authority;
  try {
    authority = validateAuthority(await readRetryAuthority({ prior, proposed }));
  } catch (error) {
    if (error instanceof SideEffectRetryAdjudicationError) throw error;
    return stop("RETRY_AUTHORITY_READ_FAILED", prior);
  }
  if (authority.decision !== "ALLOW_DISTINCT_RETRY") return stop(authority.decision === "STOP" ? "RETRY_AUTHORITY_STOP" : "RETRY_AUTHORITY_DENIED", prior);
  if (authority.identity !== proposed.control_identity) return stop("STALE_RETRY_AUTHORITY", prior);
  if (authority.identity === prior.control_identity || authority.supersedes_control_identity !== prior.control_identity) return stop("RETRY_AUTHORITY_NOT_SUPERSEDING", prior);
  if (authority.prior_fingerprint !== prior.fingerprint || authority.next_fingerprint !== proposed.fingerprint || authority.equivalence_key !== prior.equivalence_key) {
    return stop("RETRY_AUTHORITY_BINDING_MISMATCH", prior);
  }

  let retryContract;
  try {
    retryContract = validateRetryContract(await readRetryContract({ prior, proposed, authority }));
  } catch (error) {
    if (error instanceof SideEffectRetryAdjudicationError) throw error;
    return stop("RETRY_CONTRACT_READ_FAILED", prior);
  }
  if (retryContract.identity !== authority.retry_contract_identity) return stop("RETRY_CONTRACT_IDENTITY_MISMATCH", prior);
  if (retryContract.decision !== "ALLOW") return stop("RETRY_CONTRACT_DENIED", prior);
  if (retryContract.surface !== prior.surface || retryContract.action_type !== prior.action_type || retryContract.prior_status !== prior.status || retryContract.prior_reason_code !== prior.reason_code) {
    return stop("RETRY_CONTRACT_BINDING_MISMATCH", prior);
  }

  const adjudication = {
    protocol: SIDE_EFFECT_RETRY_ADJUDICATION_PROTOCOL,
    schema_version: SIDE_EFFECT_RETRY_ADJUDICATION_SCHEMA_VERSION,
    prior_fingerprint: prior.fingerprint,
    next_fingerprint: proposed.fingerprint,
    equivalence_key: prior.equivalence_key,
    authority_identity: authority.identity,
    retry_contract_identity: retryContract.identity,
    distinct_reason: proposed.distinct_reason,
  };
  return {
    decision: "ALLOW_DISTINCT_RETRY",
    reason_code: null,
    side_effect_permitted_by_this_primitive: false,
    adjudication,
    adjudication_fingerprint: sha256(adjudication),
  };
}
