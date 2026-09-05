import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createBootstrapAdmissionConsumer } from "./devexec-bootstrap-admission-consumer.mjs";
import { validateClosedLoopAdmission } from "./devexec-closed-loop-facade.mjs";

// Synthetic EPHEMERA-shaped validators. They genuinely recompute sha256
// identities and linkage (mirroring the System contract rules) without
// importing System code, so the consumer is tested against real refusal
// behavior rather than stubs that accept everything.

const THREAD_ID = "01a00000-0000-7000-8000-000000000001";
const TURN_ID = "02b00000-0000-7000-8000-000000000002";
const AT = "2026-09-05T00:00:00.000Z";
const NOW = "2026-09-05T03:00:00.000Z";
const MESSAGE = "Synthetic initial turn completion.";

function sha(content) {
  const stable = JSON.stringify(sortKeys(content));
  return `sha256:${crypto.createHash("sha256").update(stable, "utf8").digest("hex")}`;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

function planBase(value) {
  const { plan_id: _omit, ...base } = value;
  return base;
}

function syntheticValidatePlan(plan) {
  if (!plan || typeof plan !== "object") throw new Error("plan must be an object");
  if (plan.route_kind !== "bootstrap_new") throw new Error("plan route_kind mismatch");
  if (sha(planBase(plan)) !== plan.plan_id) throw new Error("plan_id mismatch");
  return Object.freeze(structuredClone(plan));
}

function syntheticValidateResult(result, plan) {
  syntheticValidatePlan(plan);
  if (!result || typeof result !== "object") throw new Error("result must be an object");
  if (result.bootstrap_plan_id !== plan.plan_id) throw new Error("result plan linkage mismatch");
  const { result_id: _a, fingerprint: _b, observed_at: _c, ...base } = result;
  if (sha(base) !== result.result_id) throw new Error("result_id mismatch");
  if (result.source_validation?.status !== "VALIDATED") throw new Error("result not source-validated");
  return Object.freeze(structuredClone(result));
}

function syntheticValidateCandidate(candidate, plan, result) {
  syntheticValidatePlan(plan);
  syntheticValidateResult(result, plan);
  if (!candidate || typeof candidate !== "object") throw new Error("candidate must be an object");
  if (candidate.bootstrap_plan_id !== plan.plan_id) throw new Error("candidate plan linkage mismatch");
  if (candidate.bootstrap_result_id !== result.result_id) throw new Error("candidate result linkage mismatch");
  if (candidate.mission_id !== plan.mission_id) throw new Error("candidate mission mismatch");
  if (candidate.thread_id !== result.identities.persisted_session.thread_id) throw new Error("candidate thread mismatch");
  if (candidate.initial_turn_id !== result.identities.initial_completed_turn.turn_id) throw new Error("candidate turn mismatch");
  const { candidate_id: _omit, ...base } = candidate;
  if (sha(base) !== candidate.candidate_id) throw new Error("candidate_id mismatch");
  return Object.freeze(structuredClone(candidate));
}

const validators = {
  validate_plan: syntheticValidatePlan,
  validate_result: syntheticValidateResult,
  validate_candidate: syntheticValidateCandidate,
};

function makeTriple({ missionId = "MISSION-1", taskId = "TASK-1", workdir, exePath, limits = null, goal = "Run the bootstrapped session." } = {}) {
  const planCore = {
    schema: "ephemera.mission-bootstrap-plan/v1",
    version: 1,
    route_kind: "bootstrap_new",
    mission_id: missionId,
    request_id: `sha256:${"a".repeat(64)}`,
    decision_id: `sha256:${"b".repeat(64)}`,
    ingress_fingerprint: `sha256:${"c".repeat(64)}`,
    binding_set_fingerprint: `sha256:${"d".repeat(64)}`,
    target_ids: ["target.workdir"],
    endpoint_ids: ["endpoint.codex"],
    execution_adapter: "codex-continuation",
    required_capabilities: ["queue"],
    requires_repository: true,
    writable_repository: true,
    authority_boundaries: { transition: "kernel_only" },
    required_identities: ["a", "b", "c", "d", "e"],
  };
  const plan = { ...planCore, plan_id: sha(planCore) };
  const resultCore = {
    schema: "ephemera.mission-bootstrap-result/v1",
    version: 1,
    bootstrap_plan_id: plan.plan_id,
    provider_adapter: "codex-continuation",
    identities: {
      persisted_session: { thread_id: THREAD_ID },
      initial_completed_turn: {
        thread_id: THREAD_ID,
        turn_id: TURN_ID,
        turn_status: "completed",
        source_turn_sha256: `sha256:${"e".repeat(64)}`,
        causal_proof: "synthetic-causal-proof",
      },
      working_directory: workdir,
      repo_root: workdir,
      runtime: { executable_path: exePath, version: "codex-test-runtime", runtime_fingerprint: null },
    },
    evidence_refs: [{ kind: "synthetic_proof", ref: { thread_id: THREAD_ID }, observed_at: AT, digest: null }],
    source_validation: { status: "VALIDATED", proof: "synthetic-proof" },
  };
  const result = { ...resultCore, result_id: sha(resultCore), fingerprint: sha(resultCore), observed_at: AT };
  const candidateCore = {
    schema: "ephemera.mission-admission-candidate/v1",
    version: 1,
    mission_id: missionId,
    task_id: taskId,
    thread_id: THREAD_ID,
    initial_turn_id: TURN_ID,
    working_directory: workdir,
    repo_root: workdir,
    runtime_path: exePath,
    chat_url: "https://chatgpt.com/c/synthetic-never-sent",
    execution_mode: "bounded",
    goal,
    current_task: "First bootstrapped turn.",
    limits,
    state_dir: null,
    admission_root: null,
    loop_id: null,
    bootstrap_plan_id: plan.plan_id,
    bootstrap_result_id: result.result_id,
    source_validation_proof: "synthetic-proof",
  };
  const candidate = { ...candidateCore, candidate_id: sha(candidateCore) };
  return { plan, result, candidate };
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-bootstrap-consumer-"));
  const exePath = path.join(root, "codex.exe");
  fs.writeFileSync(exePath, "codex-test-runtime", "utf8");
  const admissionRoot = path.join(root, "admissions");
  const probes = (threadId = THREAD_ID, turnId = TURN_ID) => ({
    runtime_probe: async () => {
      const bytes = fs.readFileSync(exePath);
      return {
        executable_path: exePath,
        launch_args: [],
        version: "codex-test-runtime",
        capabilities: { queue: true, resume: true },
        fingerprint_files: [{ path: exePath, realpath: fs.realpathSync(exePath), size: bytes.length, sha256: `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}` }],
      };
    },
    thread_proof: { message: MESSAGE },
  });
  return { root, exePath, admissionRoot, probes };
}

test("valid candidate reaches a persisted admission that re-reads and re-validates", async () => {
  const { root, exePath, admissionRoot, probes } = setup();
  try {
    const consumer = createBootstrapAdmissionConsumer(validators);
    const { plan, result, candidate } = makeTriple({ workdir: root, exePath });
    const admitted = await consumer.admitBootstrapAdmission({
      plan,
      bootstrap_result: result,
      candidate,
      execution: { admission_root: admissionRoot, ...probes(), now: () => NOW },
    });
    assert.equal(admitted.created, true);
    assert.match(admitted.admission_id, /^admit-[0-9a-f]{64}$/);
    assert.equal(admitted.candidate_id, candidate.candidate_id);
    assert.equal(admitted.plan_id, plan.plan_id);
    assert.equal(admitted.result_id, result.result_id);
    assert.equal(admitted.thread_identity.thread_id, THREAD_ID);
    assert.equal(admitted.thread_identity.initial_turn_id, TURN_ID);
    assert.equal(admitted.admission.codex_continuation_binding.thread_id, THREAD_ID);
    assert.equal(admitted.admission.initial_turn_id, TURN_ID);
    assert.equal(admitted.admission.thread_probe.turn_id, TURN_ID);
    assert.equal(admitted.admission.task_chat_binding.chat_url, "https://chatgpt.com/c/synthetic-never-sent");
    assert.ok(admitted.bindings.task_chat_binding_id);
    assert.ok(admitted.bindings.codex_continuation_binding_id);
    assert.ok(admitted.bindings.codex_runtime_binding_id);
    assert.ok(fs.existsSync(admitted.file));
    validateClosedLoopAdmission(admitted.admission);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("forged candidates are refused before any admission", async () => {
  const { root, exePath, admissionRoot, probes } = setup();
  try {
    const consumer = createBootstrapAdmissionConsumer(validators);
    const { plan, result, candidate } = makeTriple({ workdir: root, exePath });
    const tampered = structuredClone(candidate);
    tampered.goal = "Forged goal.";
    await assert.rejects(
      () => consumer.admitBootstrapAdmission({
        plan,
        bootstrap_result: result,
        candidate: tampered,
        execution: { admission_root: admissionRoot, ...probes() },
      }),
      (error) => error.code === "BOOTSTRAP_CONSUMER_VALIDATOR_REJECTED",
    );
    assert.equal(fs.existsSync(path.join(admissionRoot, "admissions-v1")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("caller thread and turn substitution is refused as forged", async () => {
  const { root, exePath, admissionRoot, probes } = setup();
  try {
    const consumer = createBootstrapAdmissionConsumer(validators);
    const { plan, result, candidate } = makeTriple({ workdir: root, exePath });
    const other = "03c00000-0000-7000-8000-000000000003";
    for (const field of ["thread_id", "initial_turn_id", "working_directory", "runtime_path", "chat_url", "mission_id", "task_id"]) {
      await assert.rejects(
        () => consumer.admitBootstrapAdmission({
          plan,
          bootstrap_result: result,
          candidate,
          execution: { admission_root: admissionRoot, ...probes(), [field]: other },
        }),
        (error) => error.code === "BOOTSTRAP_CONSUMER_FORGED_IDENTITY",
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("mission and task mismatches are refused", async () => {
  const { root, exePath, admissionRoot, probes } = setup();
  try {
    const consumer = createBootstrapAdmissionConsumer(validators);
    const { plan, result } = makeTriple({ workdir: root, exePath });
    const foreign = makeTriple({ missionId: "MISSION-2", taskId: "TASK-9", workdir: root, exePath });
    await assert.rejects(
      () => consumer.admitBootstrapAdmission({
        plan,
        bootstrap_result: result,
        candidate: foreign.candidate,
        execution: { admission_root: admissionRoot, ...probes() },
      }),
      (error) => error.code === "BOOTSTRAP_CONSUMER_VALIDATOR_REJECTED",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("unvalidated bootstrap results are refused", async () => {
  const { root, exePath, admissionRoot, probes } = setup();
  try {
    const consumer = createBootstrapAdmissionConsumer(validators);
    const { plan, result, candidate } = makeTriple({ workdir: root, exePath });
    const unvalidated = structuredClone(result);
    unvalidated.source_validation = { status: "PENDING", proof: "not-yet" };
    await assert.rejects(
      () => consumer.admitBootstrapAdmission({
        plan,
        bootstrap_result: unvalidated,
        candidate,
        execution: { admission_root: admissionRoot, ...probes() },
      }),
      (error) => error.code === "BOOTSTRAP_CONSUMER_VALIDATOR_REJECTED",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("consumer mechanically refuses unvalidated results even past a lax validator", async () => {
  const { root, exePath, admissionRoot, probes } = setup();
  try {
    const lax = {
      ...validators,
      validate_result: (value) => Object.freeze(structuredClone(value)),
      validate_candidate: (value) => Object.freeze(structuredClone(value)),
    };
    const consumer = createBootstrapAdmissionConsumer(lax);
    const { plan, result, candidate } = makeTriple({ workdir: root, exePath });
    const unvalidated = structuredClone(result);
    unvalidated.source_validation = { status: "PENDING", proof: "not-yet" };
    await assert.rejects(
      () => consumer.admitBootstrapAdmission({
        plan,
        bootstrap_result: unvalidated,
        candidate,
        execution: { admission_root: admissionRoot, ...probes() },
      }),
      (error) => error.code === "BOOTSTRAP_CONSUMER_SOURCE_UNVALIDATED",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("missing EPHEMERA validators are refused without trusting strings", async () => {
  assert.throws(
    () => createBootstrapAdmissionConsumer({ validate_plan: "VALIDATED", validate_result: () => ({}), validate_candidate: () => ({}) }),
    (error) => error.code === "BOOTSTRAP_CONSUMER_VALIDATOR_REQUIRED",
  );
  assert.throws(
    () => createBootstrapAdmissionConsumer({}),
    (error) => error.code === "BOOTSTRAP_CONSUMER_VALIDATOR_REQUIRED",
  );
});

test("replay with the same identity converges on the existing admission", async () => {
  const { root, exePath, admissionRoot, probes } = setup();
  try {
    const consumer = createBootstrapAdmissionConsumer(validators);
    const { plan, result, candidate } = makeTriple({ workdir: root, exePath });
    const first = await consumer.admitBootstrapAdmission({
      plan,
      bootstrap_result: result,
      candidate,
      execution: { admission_root: admissionRoot, ...probes(), now: () => NOW },
    });
    assert.equal(first.created, true);
    const second = await consumer.admitBootstrapAdmission({
      plan,
      bootstrap_result: result,
      candidate,
      execution: {
        admission_root: admissionRoot,
        runtime_probe: async () => { throw new Error("replay must not re-probe runtime"); },
        thread_proof: { message: "replay must not use this message" },
        now: () => NOW,
      },
    });
    assert.equal(second.created, false);
    assert.equal(second.admission_id, first.admission_id);
    assert.deepEqual(second.thread_identity, first.thread_identity);
    assert.equal(second.file, first.file);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("conflicting admission fails closed through the source-owned conflict", async () => {
  const { root, exePath, admissionRoot, probes } = setup();
  try {
    const consumer = createBootstrapAdmissionConsumer(validators);
    const first = makeTriple({ workdir: root, exePath });
    const admitted = await consumer.admitBootstrapAdmission({
      plan: first.plan,
      bootstrap_result: first.result,
      candidate: first.candidate,
      execution: { admission_root: admissionRoot, ...probes(), now: () => NOW },
    });
    assert.equal(admitted.created, true);
    const second = makeTriple({ workdir: root, exePath, limits: { mode: "bounded", max_rounds: 3 } });
    await assert.rejects(
      () => consumer.admitBootstrapAdmission({
        plan: second.plan,
        bootstrap_result: second.result,
        candidate: second.candidate,
        execution: { admission_root: admissionRoot, ...probes(), now: () => NOW },
      }),
      (error) => error.code === "CLOSED_LOOP_ADMISSION_CONFLICT",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});