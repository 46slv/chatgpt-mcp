import crypto from "node:crypto";

export const SCHEDULED_WORKER_GITHUB_SIDE_EFFECT_PROTOCOL = "devexec.scheduled-worker-github-side-effect";
export const SCHEDULED_WORKER_GITHUB_SIDE_EFFECT_SCHEMA_VERSION = 1;

const MAX_TEXT = 1024;
const MAX_CANONICAL_BYTES = 64 * 1024;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_OPERATIONS = new Set([
  "create_branch",
  "update_ref",
  "create_file",
  "update_file",
  "create_pull_request",
  "update_pull_request",
]);

export class ScheduledWorkerGitHubSideEffectError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = "ScheduledWorkerGitHubSideEffectError";
    this.code = code;
  }
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function bounded(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ScheduledWorkerGitHubSideEffectError("SCHEDULED_WORKER_SIDE_EFFECT_INVALID", `${label} is invalid`);
  }
  return value;
}

function canonical(value, depth = 0) {
  if (depth > 32) throw new ScheduledWorkerGitHubSideEffectError("SCHEDULED_WORKER_SIDE_EFFECT_INVALID", "mutation payload is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ScheduledWorkerGitHubSideEffectError("SCHEDULED_WORKER_SIDE_EFFECT_INVALID", "mutation payload contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => {
      if (typeof value[key] === "undefined" || typeof value[key] === "function" || typeof value[key] === "symbol" || typeof value[key] === "bigint") {
        throw new ScheduledWorkerGitHubSideEffectError("SCHEDULED_WORKER_SIDE_EFFECT_INVALID", "mutation payload contains an unsupported value");
      }
      return `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`;
    }).join(",")}}`;
  }
  throw new ScheduledWorkerGitHubSideEffectError("SCHEDULED_WORKER_SIDE_EFFECT_INVALID", "mutation payload contains an unsupported value");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeMutation(input) {
  if (!isObject(input)) throw new ScheduledWorkerGitHubSideEffectError("SCHEDULED_WORKER_SIDE_EFFECT_INVALID", "mutation must be an object");
  const repository = bounded(input.repository, "mutation.repository");
  if (!REPOSITORY.test(repository)) throw new ScheduledWorkerGitHubSideEffectError("SCHEDULED_WORKER_SIDE_EFFECT_INVALID", "mutation.repository must be owner/repo");
  const operation = bounded(input.operation, "mutation.operation");
  if (!SAFE_OPERATIONS.has(operation)) throw new ScheduledWorkerGitHubSideEffectError("SCHEDULED_WORKER_SIDE_EFFECT_UNSUPPORTED", `unsupported GitHub mutation operation: ${operation}`);
  const resource = bounded(input.resource, "mutation.resource");
  if (!isObject(input.payload)) throw new ScheduledWorkerGitHubSideEffectError("SCHEDULED_WORKER_SIDE_EFFECT_INVALID", "mutation.payload must be an object");
  if (operation === "update_ref" && input.payload.force === true) {
    throw new ScheduledWorkerGitHubSideEffectError("SCHEDULED_WORKER_SIDE_EFFECT_UNSUPPORTED", "force ref updates are forbidden on the Scheduled-Worker seam");
  }
  const payloadCanonical = canonical(input.payload);
  if (Buffer.byteLength(payloadCanonical, "utf8") > MAX_CANONICAL_BYTES) {
    throw new ScheduledWorkerGitHubSideEffectError("SCHEDULED_WORKER_SIDE_EFFECT_INVALID", "mutation payload is too large to fingerprint safely");
  }
  return {
    repository,
    operation,
    resource,
    payload: input.payload,
    payload_fingerprint: `sha256:${sha256(payloadCanonical)}`,
    expected_precondition: bounded(input.expected_precondition, "mutation.expected_precondition"),
    expected_post_identity: bounded(input.expected_post_identity, "mutation.expected_post_identity"),
    control_identity: bounded(input.control_identity, "mutation.control_identity"),
    prior_attempt_id: input.prior_attempt_id === null || input.prior_attempt_id === undefined ? null : bounded(input.prior_attempt_id, "mutation.prior_attempt_id"),
    distinct_reason: input.distinct_reason === null || input.distinct_reason === undefined ? null : bounded(input.distinct_reason, "mutation.distinct_reason"),
  };
}

export function deriveScheduledWorkerGitHubAction(input) {
  const mutation = normalizeMutation(input);
  return {
    mutation,
    action: {
      surface: "github-scheduled-worker",
      action_type: mutation.operation,
      target: `${mutation.repository}:${mutation.resource}`,
      immutable_input: mutation.payload_fingerprint,
      expected_precondition: mutation.expected_precondition,
      prior_attempt_id: mutation.prior_attempt_id,
      control_identity: mutation.control_identity,
      distinct_reason: mutation.distinct_reason,
    },
  };
}

async function defaultDependencies() {
  const [guard, inspection, retry] = await Promise.all([
    import("./devexec-side-effect-fingerprint-guard.mjs"),
    import("./devexec-side-effect-equivalence-inspection.mjs"),
    import("./devexec-side-effect-retry-adjudication.mjs"),
  ]);
  return {
    deriveSideEffectFingerprint: guard.deriveSideEffectFingerprint,
    runSideEffectWithFingerprintGuard: guard.runSideEffectWithFingerprintGuard,
    inspectSideEffectEquivalenceState: inspection.inspectSideEffectEquivalenceState,
    adjudicateDistinctSideEffectRetry: retry.adjudicateDistinctSideEffectRetry,
  };
}

async function dependenciesOrDefault(dependencies) {
  if (dependencies !== undefined && dependencies !== null) return dependencies;
  return defaultDependencies();
}

function requireFunction(value, label) {
  if (typeof value !== "function") throw new ScheduledWorkerGitHubSideEffectError("SCHEDULED_WORKER_SIDE_EFFECT_INVALID", `${label} is required`);
  return value;
}

function classifyIdentity(observed, expected) {
  if (observed === null) return { state: "ABSENT", identity: null };
  if (typeof observed !== "string" || !observed.trim()) return { state: "UNKNOWN", identity: null };
  return observed === expected
    ? { state: "MATCH", identity: observed }
    : { state: "MISMATCH", identity: observed };
}

export async function runScheduledWorkerGitHubMutation({
  stateDir,
  mutation: mutationInput,
  readControlIdentity,
  readGitHubIdentity,
  executeGitHubMutation,
  dependencies,
  now,
} = {}) {
  requireFunction(readControlIdentity, "readControlIdentity");
  requireFunction(readGitHubIdentity, "readGitHubIdentity");
  requireFunction(executeGitHubMutation, "executeGitHubMutation");
  const { mutation, action } = deriveScheduledWorkerGitHubAction(mutationInput);
  const deps = await dependenciesOrDefault(dependencies);
  requireFunction(deps.runSideEffectWithFingerprintGuard, "dependencies.runSideEffectWithFingerprintGuard");

  return deps.runSideEffectWithFingerprintGuard({
    stateDir,
    action,
    readControlIdentity,
    readPrecondition: async () => readGitHubIdentity({ phase: "PRE", mutation, action }),
    execute: async () => executeGitHubMutation({ mutation, action }),
    readBack: async () => {
      try {
        const observed = await readGitHubIdentity({ phase: "POST", mutation, action });
        return classifyIdentity(observed, mutation.expected_post_identity);
      } catch {
        return { state: "UNKNOWN", identity: null };
      }
    },
    ...(now === undefined ? {} : { now }),
  });
}

export async function inspectScheduledWorkerGitHubMutation({ stateDir, mutation: mutationInput, dependencies } = {}) {
  const { mutation, action } = deriveScheduledWorkerGitHubAction(mutationInput);
  const deps = await dependenciesOrDefault(dependencies);
  requireFunction(deps.inspectSideEffectEquivalenceState, "dependencies.inspectSideEffectEquivalenceState");
  const inspection = deps.inspectSideEffectEquivalenceState({ stateDir, action });
  return {
    protocol: SCHEDULED_WORKER_GITHUB_SIDE_EFFECT_PROTOCOL,
    schema_version: SCHEDULED_WORKER_GITHUB_SIDE_EFFECT_SCHEMA_VERSION,
    mutation: {
      repository: mutation.repository,
      operation: mutation.operation,
      resource: mutation.resource,
      payload_fingerprint: mutation.payload_fingerprint,
    },
    inspection,
  };
}

function priorForAdjudication(record) {
  return {
    fingerprint: record.fingerprint,
    equivalence_key: record.equivalence_key,
    surface: record.action.surface,
    action_type: record.action.action_type,
    target: record.action.target,
    immutable_input: record.action.immutable_input,
    status: record.status,
    reason_code: record.reason_code,
    control_identity: record.action.control_identity,
  };
}

function proposedForAdjudication(derived, action) {
  return {
    fingerprint: derived.fingerprint,
    equivalence_key: derived.equivalence_key,
    surface: action.surface,
    action_type: action.action_type,
    target: action.target,
    immutable_input: action.immutable_input,
    control_identity: action.control_identity,
    prior_attempt_id: action.prior_attempt_id,
    distinct_reason: action.distinct_reason,
  };
}

export async function adjudicateScheduledWorkerGitHubRetry({
  stateDir,
  mutation: mutationInput,
  readRetryAuthority,
  readRetryContract,
  dependencies,
} = {}) {
  requireFunction(readRetryAuthority, "readRetryAuthority");
  requireFunction(readRetryContract, "readRetryContract");
  const { mutation, action } = deriveScheduledWorkerGitHubAction(mutationInput);
  const deps = await dependenciesOrDefault(dependencies);
  requireFunction(deps.deriveSideEffectFingerprint, "dependencies.deriveSideEffectFingerprint");
  requireFunction(deps.inspectSideEffectEquivalenceState, "dependencies.inspectSideEffectEquivalenceState");
  requireFunction(deps.adjudicateDistinctSideEffectRetry, "dependencies.adjudicateDistinctSideEffectRetry");

  const inspection = deps.inspectSideEffectEquivalenceState({ stateDir, action });
  if (inspection === null) {
    return { decision: "STOP", reason_code: "NO_PRIOR_EQUIVALENT_ATTEMPT", side_effect_permitted: false, inspection: null };
  }
  if (inspection.state === "OWNER_ONLY" || inspection.record === null) {
    return { decision: "STOP", reason_code: "OWNER_ONLY_REQUIRES_OPERATOR_ADJUDICATION", side_effect_permitted: false, inspection };
  }

  const derived = deps.deriveSideEffectFingerprint(action);
  const adjudication = await deps.adjudicateDistinctSideEffectRetry({
    prior: priorForAdjudication(inspection.record),
    proposed: proposedForAdjudication(derived, action),
    readRetryAuthority,
    readRetryContract,
  });

  return {
    ...adjudication,
    side_effect_permitted: false,
    execution_gate: "CLOSED",
    inspection,
    mutation: {
      repository: mutation.repository,
      operation: mutation.operation,
      resource: mutation.resource,
      payload_fingerprint: mutation.payload_fingerprint,
    },
  };
}
