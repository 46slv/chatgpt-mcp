import path from "node:path";

import {
  admitExistingCodexTask,
  loadClosedLoopAdmission,
  validateClosedLoopAdmission,
} from "./devexec-closed-loop-facade.mjs";
import { probeCodexRuntime } from "./devexec-codex-runtime-binding.mjs";

// EPHEMERA Bootstrap Admission Consumer.
//
// Connects a validated EPHEMERA bootstrap_new Admission Candidate to the
// source-owned admitExistingCodexTask seam so a freshly bootstrapped Codex
// session can become a formal persisted closed-loop admission. Nothing from
// the EPHEMERA admission side is copied or reimplemented here: no admission
// schema, no admission hashing, no thread proof. Conversely no Dev Exec
// admission internals are exported to EPHEMERA. The candidate, plan, and
// result are re-verified through caller-injected EPHEMERA validators plus
// mechanical cross-linkage checks performed here; a bare "VALIDATED" string
// is never trusted on its own.
//
// Every admission identity comes from the validated candidate. The caller
// may only supply explicit roots (admission_root, state_dir), probe
// overrides (runtime_probe, thread_proof message), and timeouts. Any
// caller-supplied thread, turn, workdir, repo, runtime, chat, mission, or
// task identity is refused as forged. No --last, current session, fuzzy
// thread discovery, or PATH lookup is consulted anywhere: the facade admits
// only the exact thread_id/initial_turn_id pair, proven by the source-owned
// runtime probe and the source-owned app-server turn proof (or an injected
// exact initial-turn message that the facade re-hashes itself).

export const BOOTSTRAP_ADMISSION_CONSUMER_VERSION = 1;
export const EPHEMERA_BOOTSTRAP_ROUTE_KIND = "bootstrap_new";

const SHA256_RE = /^sha256:[0-9a-f]{64}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Identity fields that must come exclusively from the validated candidate.
// A caller carrying any of them is substituting identities and is refused.
const FORBIDDEN_CALLER_FIELDS = Object.freeze([
  "mission_id",
  "missionId",
  "task_id",
  "taskId",
  "thread_id",
  "threadId",
  "initial_turn_id",
  "initialTurnId",
  "turn_id",
  "turnId",
  "chat_url",
  "chatUrl",
  "working_directory",
  "workingDirectory",
  "cwd",
  "repo_root",
  "repoRoot",
  "runtime_path",
  "runtimePath",
  "executable_path",
  "execution_mode",
  "mode",
  "goal",
  "current_task",
  "currentTask",
  "limits",
  "loop_id",
  "loopId",
  "bootstrap_plan_id",
  "bootstrap_result_id",
]);

const EXECUTION_FIELDS = Object.freeze([
  "admission_root",
  "admissionRoot",
  "state_dir",
  "stateDir",
  "runtime_probe",
  "runtimeProbe",
  "runtime_launch_args",
  "runtimeLaunchArgs",
  "thread_proof",
  "threadProbe",
  "thread_probe_timeout_ms",
  "threadProbeTimeoutMs",
  "now",
]);

export const BOOTSTRAP_CONSUMER_ERRORS = Object.freeze({
  REQUIRED: "BOOTSTRAP_CONSUMER_REQUIRED",
  INVALID: "BOOTSTRAP_CONSUMER_INVALID",
  VALIDATOR_REQUIRED: "BOOTSTRAP_CONSUMER_VALIDATOR_REQUIRED",
  VALIDATOR_REJECTED: "BOOTSTRAP_CONSUMER_VALIDATOR_REJECTED",
  LINKAGE_INVALID: "BOOTSTRAP_CONSUMER_LINKAGE_INVALID",
  SOURCE_UNVALIDATED: "BOOTSTRAP_CONSUMER_SOURCE_UNVALIDATED",
  FORGED_IDENTITY: "BOOTSTRAP_CONSUMER_FORGED_IDENTITY",
  RELOAD_MISMATCH: "BOOTSTRAP_CONSUMER_RELOAD_MISMATCH",
});

export class BootstrapAdmissionConsumerError extends Error {
  constructor(message, code = BOOTSTRAP_CONSUMER_ERRORS.INVALID, cause = undefined) {
    super(message);
    this.name = "BootstrapAdmissionConsumerError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function fail(code, message, cause = undefined) {
  throw new BootstrapAdmissionConsumerError(message, code, cause);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredText(value, label, code = BOOTSTRAP_CONSUMER_ERRORS.REQUIRED) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    fail(code, `${label} must be an exact non-empty string.`);
  }
  return value;
}

function sha256id(value, label) {
  const text = requiredText(value, label, BOOTSTRAP_CONSUMER_ERRORS.LINKAGE_INVALID);
  if (!SHA256_RE.test(text)) fail(BOOTSTRAP_CONSUMER_ERRORS.LINKAGE_INVALID, `${label} must be a sha256 identity.`);
  return text;
}

function uuid(value, label) {
  const text = requiredText(value, label, BOOTSTRAP_CONSUMER_ERRORS.LINKAGE_INVALID);
  if (!UUID_RE.test(text)) fail(BOOTSTRAP_CONSUMER_ERRORS.LINKAGE_INVALID, `${label} must be a UUID.`);
  return text;
}

function absoluteDir(value, label) {
  const text = requiredText(value, label, BOOTSTRAP_CONSUMER_ERRORS.INVALID);
  if (!(path.isAbsolute(text) || path.win32.isAbsolute(text) || path.posix.isAbsolute(text))) {
    fail(BOOTSTRAP_CONSUMER_ERRORS.INVALID, `${label} must be an absolute path.`);
  }
  return text;
}

function checkLinkedIdentities(plan, result, candidate) {
  if (plan.route_kind !== EPHEMERA_BOOTSTRAP_ROUTE_KIND) {
    fail(BOOTSTRAP_CONSUMER_ERRORS.LINKAGE_INVALID, "Bootstrap plan is not a bootstrap_new plan.");
  }
  sha256id(plan.plan_id, "plan.plan_id");
  sha256id(candidate.candidate_id, "candidate.candidate_id");
  sha256id(result.result_id, "bootstrap_result.result_id");
  if (result.bootstrap_plan_id !== plan.plan_id) {
    fail(BOOTSTRAP_CONSUMER_ERRORS.LINKAGE_INVALID, "Bootstrap result does not reference this bootstrap plan.");
  }
  if (candidate.bootstrap_plan_id !== plan.plan_id) {
    fail(BOOTSTRAP_CONSUMER_ERRORS.LINKAGE_INVALID, "Admission candidate does not reference this bootstrap plan.");
  }
  if (candidate.bootstrap_result_id !== result.result_id) {
    fail(BOOTSTRAP_CONSUMER_ERRORS.LINKAGE_INVALID, "Admission candidate does not reference this bootstrap result.");
  }
  if (candidate.mission_id !== plan.mission_id) {
    fail(BOOTSTRAP_CONSUMER_ERRORS.LINKAGE_INVALID, "Admission candidate mission does not match the bootstrap plan.");
  }
  const sessionThread = result.identities?.persisted_session?.thread_id;
  const resultTurn = result.identities?.initial_completed_turn?.turn_id;
  if (candidate.thread_id !== sessionThread) {
    fail(BOOTSTRAP_CONSUMER_ERRORS.LINKAGE_INVALID, "Admission candidate thread does not match the validated bootstrap result.");
  }
  if (candidate.initial_turn_id !== resultTurn) {
    fail(BOOTSTRAP_CONSUMER_ERRORS.LINKAGE_INVALID, "Admission candidate turn does not match the validated bootstrap result.");
  }
  uuid(candidate.thread_id, "candidate.thread_id");
  uuid(candidate.initial_turn_id, "candidate.initial_turn_id");
  const validation = result.source_validation;
  if (!isObject(validation) || validation.status !== "VALIDATED") {
    fail(BOOTSTRAP_CONSUMER_ERRORS.SOURCE_UNVALIDATED, "Bootstrap result without source-owned VALIDATED status is refused.");
  }
  requiredText(validation.proof, "bootstrap_result.source_validation.proof", BOOTSTRAP_CONSUMER_ERRORS.SOURCE_UNVALIDATED);
  requiredText(candidate.mission_id, "candidate.mission_id", BOOTSTRAP_CONSUMER_ERRORS.LINKAGE_INVALID);
  requiredText(candidate.task_id, "candidate.task_id", BOOTSTRAP_CONSUMER_ERRORS.LINKAGE_INVALID);
  const chatUrl = requiredText(candidate.chat_url, "candidate.chat_url", BOOTSTRAP_CONSUMER_ERRORS.LINKAGE_INVALID);
  if (!chatUrl.startsWith("https://")) {
    fail(BOOTSTRAP_CONSUMER_ERRORS.LINKAGE_INVALID, "Admission candidate chat_url must be an explicit https URL.");
  }
  absoluteDir(candidate.working_directory, "candidate.working_directory");
  if (candidate.repo_root !== null && candidate.repo_root !== undefined) {
    absoluteDir(candidate.repo_root, "candidate.repo_root");
  }
  absoluteDir(candidate.runtime_path, "candidate.runtime_path");
}

// The EPHEMERA validators are injected so this repo never copies the System
// contract code. Each must be a real function; a status string or any other
// non-function value is refused instead of trusted.
export function createBootstrapAdmissionConsumer({ validate_plan, validate_result, validate_candidate } = {}) {
  if (typeof validate_plan !== "function") {
    fail(BOOTSTRAP_CONSUMER_ERRORS.VALIDATOR_REQUIRED, "An EPHEMERA plan validator function is required; a VALIDATED string is never trusted.");
  }
  if (typeof validate_result !== "function") {
    fail(BOOTSTRAP_CONSUMER_ERRORS.VALIDATOR_REQUIRED, "An EPHEMERA result validator function is required; a VALIDATED string is never trusted.");
  }
  if (typeof validate_candidate !== "function") {
    fail(BOOTSTRAP_CONSUMER_ERRORS.VALIDATOR_REQUIRED, "An EPHEMERA candidate validator function is required; a VALIDATED string is never trusted.");
  }

  function validatedTriple(plan, bootstrap_result, candidate) {
    let checkedPlan;
    let checkedResult;
    let checkedCandidate;
    try {
      checkedPlan = validate_plan(plan);
    } catch (error) {
      fail(BOOTSTRAP_CONSUMER_ERRORS.VALIDATOR_REJECTED, "The EPHEMERA plan failed its own validation.", error);
    }
    try {
      checkedResult = validate_result(bootstrap_result, checkedPlan);
    } catch (error) {
      fail(BOOTSTRAP_CONSUMER_ERRORS.VALIDATOR_REJECTED, "The EPHEMERA bootstrap result failed its own validation.", error);
    }
    try {
      checkedCandidate = validate_candidate(candidate, checkedPlan, checkedResult);
    } catch (error) {
      fail(BOOTSTRAP_CONSUMER_ERRORS.VALIDATOR_REJECTED, "The EPHEMERA admission candidate failed its own validation.", error);
    }
    if (!isObject(checkedPlan) || !isObject(checkedResult) || !isObject(checkedCandidate)) {
      fail(BOOTSTRAP_CONSUMER_ERRORS.VALIDATOR_REJECTED, "EPHEMERA validators must return the validated objects.");
    }
    checkLinkedIdentities(checkedPlan, checkedResult, checkedCandidate);
    return Object.freeze({ plan: checkedPlan, result: checkedResult, candidate: checkedCandidate });
  }

  // Admit one validated bootstrap triple. Source-owned failures from
  // admitExistingCodexTask (thread unproven, runtime drift, admission
  // conflict) propagate unchanged so nothing masks a fail-closed boundary.
  async function admitBootstrapAdmission({ plan, bootstrap_result, candidate, execution = {} } = {}) {
    if (!isObject(execution)) fail(BOOTSTRAP_CONSUMER_ERRORS.INVALID, "execution must be a plain object.");
    for (const key of Object.keys(execution)) {
      if (FORBIDDEN_CALLER_FIELDS.includes(key)) {
        fail(BOOTSTRAP_CONSUMER_ERRORS.FORGED_IDENTITY, `Admission identity must come from the validated candidate, not the caller: ${key}.`);
      }
      if (!EXECUTION_FIELDS.includes(key)) {
        fail(BOOTSTRAP_CONSUMER_ERRORS.INVALID, `execution contains an unknown field: ${key}.`);
      }
    }
    const { plan: checkedPlan, result: checkedResult, candidate: checked } = validatedTriple(plan, bootstrap_result, candidate);

    const admissionRootRaw = execution.admission_root ?? execution.admissionRoot ?? checked.admission_root ?? null;
    if (admissionRootRaw === null) {
      fail(BOOTSTRAP_CONSUMER_ERRORS.INVALID, "An explicit admission_root is required; the shared production default is never used implicitly.");
    }
    const admissionRoot = absoluteDir(admissionRootRaw, "admission_root");
    const stateDir = execution.state_dir ?? execution.stateDir ?? checked.state_dir ?? null;
    const runtimeProbe = execution.runtime_probe ?? execution.runtimeProbe ?? null;
    const runtimeLaunchArgsRaw = execution.runtime_launch_args ?? execution.runtimeLaunchArgs ?? null;
    let runtimeLaunchArgs = null;
    if (runtimeLaunchArgsRaw !== null) {
      if (!Array.isArray(runtimeLaunchArgsRaw)) {
        fail(BOOTSTRAP_CONSUMER_ERRORS.INVALID, "execution.runtime_launch_args must be an array.");
      }
      if (runtimeLaunchArgsRaw.length === 0) {
        runtimeLaunchArgs = null;
      } else {
        runtimeLaunchArgs = runtimeLaunchArgsRaw.map((entry, index) => requiredText(entry, `execution.runtime_launch_args[${index}]`, BOOTSTRAP_CONSUMER_ERRORS.INVALID));
      }
    }
    if (runtimeProbe !== null && typeof runtimeProbe !== "function") {
      fail(BOOTSTRAP_CONSUMER_ERRORS.INVALID, "execution.runtime_probe must be a function.");
    }
    const threadProof = execution.thread_proof ?? execution.threadProbe ?? null;
    let threadProbe = null;
    if (threadProof !== null) {
      if (!isObject(threadProof)) fail(BOOTSTRAP_CONSUMER_ERRORS.INVALID, "execution.thread_proof must be a plain object.");
      for (const key of Object.keys(threadProof)) {
        if (key !== "message" && key !== "causal_proof") fail(BOOTSTRAP_CONSUMER_ERRORS.INVALID, `execution.thread_proof contains an unknown field: ${key}.`);
      }
      const message = requiredText(threadProof.message, "execution.thread_proof.message", BOOTSTRAP_CONSUMER_ERRORS.INVALID);
      const proofCausal = threadProof.causal_proof === undefined || threadProof.causal_proof === null
        ? null
        : requiredText(threadProof.causal_proof, "execution.thread_proof.causal_proof", BOOTSTRAP_CONSUMER_ERRORS.INVALID);
      const threadId = checked.thread_id;
      const turnId = checked.initial_turn_id;
      threadProbe = async () => ({
        thread_id: threadId,
        turn_id: turnId,
        turn_status: "completed",
        message,
        ...(proofCausal === null ? {} : { causal_proof: proofCausal }),
      });
    }
    const timeoutMs = execution.thread_probe_timeout_ms ?? execution.threadProbeTimeoutMs ?? null;
    if (timeoutMs !== null && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
      fail(BOOTSTRAP_CONSUMER_ERRORS.INVALID, "execution.thread_probe_timeout_ms must be a positive integer.");
    }
    const now = execution.now ?? null;
    if (now !== null && typeof now !== "function") {
      fail(BOOTSTRAP_CONSUMER_ERRORS.INVALID, "execution.now must be a function.");
    }

    const repoRoot = checked.repo_root === null || checked.repo_root === undefined ? undefined : absoluteDir(checked.repo_root, "candidate.repo_root");
    const facadeInput = {
      mission_id: checked.mission_id,
      task_id: checked.task_id,
      thread_id: checked.thread_id,
      initial_turn_id: checked.initial_turn_id,
      chat_url: checked.chat_url,
      chat_source: "ephemera-bootstrap-candidate",
      runtime_path: checked.runtime_path,
      runtime_provenance: "ephemera-bootstrap-consumer-runtime",
      launch_args: runtimeLaunchArgs ?? undefined,
      working_directory: checked.working_directory,
      execution_mode: checked.execution_mode,
      goal: checked.goal,
      current_task: checked.current_task,
      limits: checked.limits,
      loop_id: checked.loop_id,
      repo_root: repoRoot,
      admission_root: admissionRoot,
      state_dir: stateDir ?? undefined,
      runtime_probe: runtimeProbe ?? undefined,
      thread_probe: threadProbe ?? undefined,
      thread_probe_timeout_ms: timeoutMs ?? undefined,
      now: now ?? undefined,
    };

    const admitted = await admitExistingCodexTask(facadeInput);

    // Terminal gate: re-read the persisted admission through the
    // source-owned loader and validator, then confirm every identity the
    // candidate promised. admitExistingCodexTask never runs the loop.
    const reloaded = validateClosedLoopAdmission(loadClosedLoopAdmission(admitted.file));
    if (reloaded.admission_id !== admitted.admission.admission_id) {
      fail(BOOTSTRAP_CONSUMER_ERRORS.RELOAD_MISMATCH, "Re-read admission does not match the admitted admission.");
    }
    const samePath = (left, right) => {
      if (left === null || left === undefined || right === null || right === undefined) return (left ?? null) === (right ?? null);
      return path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
    };
    if (reloaded.codex_continuation_binding.thread_id !== checked.thread_id
      || reloaded.initial_turn_id !== checked.initial_turn_id
      || !samePath(reloaded.codex_continuation_binding.working_directory, checked.working_directory)
      || !samePath(reloaded.codex_continuation_binding.repo_root, checked.repo_root)
      || !samePath(reloaded.codex_runtime_binding.executable_path, checked.runtime_path)
      || reloaded.task_chat_binding.chat_url !== checked.chat_url
      || reloaded.mission_id !== checked.mission_id
      || reloaded.task_id !== checked.task_id) {
      fail(BOOTSTRAP_CONSUMER_ERRORS.RELOAD_MISMATCH, "Re-read admission identities do not match the validated candidate.");
    }

    return Object.freeze({
      admission: admitted.admission,
      created: admitted.created,
      file: admitted.file,
      admission_id: admitted.admission.admission_id,
      candidate_id: checked.candidate_id,
      plan_id: checkedPlan.plan_id,
      result_id: checkedResult.result_id,
      thread_identity: admitted.thread_identity,
      bindings: Object.freeze({
        task_chat_binding_id: admitted.admission.task_chat_binding.binding_id,
        codex_continuation_binding_id: admitted.admission.codex_continuation_binding.binding_id,
        codex_runtime_binding_id: admitted.admission.codex_runtime_binding.binding_id,
      }),
      thread_proof: admitted.admission.thread_probe,
    });
  }

  return Object.freeze({ admitBootstrapAdmission });
}

// Default live wiring: source-owned runtime probe. The live app-server turn
// proof is the facade default when no thread_proof message is supplied.
export function liveRuntimeProbe(input) {
  return probeCodexRuntime(input);
}