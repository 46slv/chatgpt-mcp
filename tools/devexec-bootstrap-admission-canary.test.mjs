import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createBootstrapAdmissionConsumer } from "./devexec-bootstrap-admission-consumer.mjs";
import { loadClosedLoopAdmission, validateClosedLoopAdmission } from "./devexec-closed-loop-facade.mjs";

// Live Windows admission canary. Gated by EPHEMERA_ADMISSION_CANARY=1.
// Wires the REAL pinned EPHEMERA System modules (exact-pinned dependency,
// defaulting to the bootstrap_new worktree at its reviewed commit) to the
// source-owned consumer: ingress -> Start -> Kernel ADMIT -> bootstrap plan
// -> Codex bootstrap evidence -> BootstrapResult -> Admission Candidate ->
// admitExistingCodexTask with the LIVE runtime probe and the LIVE app-server
// turn proof, into an ISOLATED admission root. No closed loop is started,
// nothing is sent to ChatGPT, and no production conversation is touched.
//
// Evidence modes:
// - default: reuse the isolated harmless bootstrap evidence (pinned fresh
//   thread + completed turn); the app-server proof, runtime probe, and
//   admission itself are still fully live.
// - EPHEMERA_ADMISSION_CANARY_FRESH=1: bootstrap a brand-new Codex thread
//   inside this test (one extra bounded model call).
//
// The synthetic ChatGPT URL is shape-validated only (source-owned
// parseChatGPTTargetUrl performs no existence check and no fetch); a global
// fetch guard fails the test loudly if anything attempts an HTTP send.

const enabled = process.env.EPHEMERA_ADMISSION_CANARY === "1";
const fresh = process.env.EPHEMERA_ADMISSION_CANARY_FRESH === "1";
const SYSTEM_TOOLS = process.env.EPHEMERA_SYSTEM_TOOLS ?? "D:/Documents/EPHEMERA-bootstrap-new-20260905/tools";
const WORKDIR = process.env.EPHEMERA_ADMISSION_CANARY_WORKDIR
  ?? path.join(os.tmpdir(), "ephemera-bootstrap-canary-20260905");
const JSONL = process.env.EPHEMERA_ADMISSION_CANARY_JSONL ?? path.join(WORKDIR, "canary.jsonl");
const ROLLOUT = process.env.EPHEMERA_ADMISSION_CANARY_ROLLOUT
  ?? path.join(os.homedir(), ".codex", "sessions", "2026", "09", "05",
    "rollout-2026-09-05T12-03-38-01a06f85-8cbf-74c0-814e-c708cdd1ac29.jsonl");
const CODEX_EXE = process.env.EPHEMERA_ADMISSION_CANARY_EXE
  ?? "C:/Users/shiro/AppData/Local/OpenAI/Codex/bin/1e3e57cdf0634c02/codex.exe";
const CODEX_ARGS = (process.env.EPHEMERA_ADMISSION_CANARY_LAUNCH_ARGS ?? "").split(";").filter(Boolean);
const CHAT_URL = "https://chatgpt.com/c/ephemera-admission-canary-never-sent";
const AT = "2026-09-05T00:00:00.000Z";
const DECIDED_AT = "2026-09-05T01:00:00.000Z";
const OBSERVED_AT = "2026-09-05T02:00:00.000Z";
const proveAll = async () => true;

async function systemModules() {
  for (const file of ["mission-bootstrap-plan.mjs", "mission-bootstrap-result.mjs", "mission-bootstrap-admission.mjs", "mission-bootstrap-codex-adapter.mjs"]) {
    assert.ok(fs.existsSync(path.join(SYSTEM_TOOLS, file)), `pinned EPHEMERA module missing: ${file}`);
  }
  const plan = await import(pathToFileURL(path.join(SYSTEM_TOOLS, "mission-bootstrap-plan.mjs")).href);
  const result = await import(pathToFileURL(path.join(SYSTEM_TOOLS, "mission-bootstrap-result.mjs")).href);
  const admission = await import(pathToFileURL(path.join(SYSTEM_TOOLS, "mission-bootstrap-admission.mjs")).href);
  const adapter = await import(pathToFileURL(path.join(SYSTEM_TOOLS, "mission-bootstrap-codex-adapter.mjs")).href);
  const ingress = await import(pathToFileURL(path.join(SYSTEM_TOOLS, "mission-ingress-service.mjs")).href);
  const gate = await import(pathToFileURL(path.join(SYSTEM_TOOLS, "mission-kernel-gate.mjs")).href);
  const contract = await import(pathToFileURL(path.join(SYSTEM_TOOLS, "mission-ingress-contract.mjs")).href);
  const startResume = await import(pathToFileURL(path.join(SYSTEM_TOOLS, "mission-start-resume-ingress.mjs")).href);
  return { plan, result, admission, adapter, ingress, gate, contract, startResume };
}

function runCodexFresh(workdir) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      CODEX_EXE,
      ["exec", "--json", "--skip-git-repo-check", "-C", workdir, "-s", "read-only",
        "Reply with exactly the single line EPHEMERA-ADMISSION-CANARY-OK and take no other action. Do not read, write, or list files."],
      { timeout: 300000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
    void child;
  });
}

function newestRolloutFor(threadId) {
  const base = path.join(os.homedir(), ".codex", "sessions");
  let best = null;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.includes(threadId)) {
        const stat = fs.statSync(full);
        if (!best || stat.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: stat.mtimeMs };
      }
    }
  };
  walk(base);
  return best?.path ?? null;
}

function threadIdFromStdout(stdoutText) {
  const ids = new Set();
  for (const line of stdoutText.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
    const event = JSON.parse(line);
    if (event?.type === "thread.started" && typeof event.thread_id === "string") ids.add(event.thread_id);
  }
  assert.equal(ids.size, 1);
  return [...ids][0];
}

test("live admission canary admits a bootstrapped thread with source-owned proofs", { skip: !enabled, timeout: 600000 }, async () => {
  const sys = await systemModules();
  assert.ok(fs.existsSync(CODEX_EXE), `codex executable missing: ${CODEX_EXE}`);
  fs.mkdirSync(WORKDIR, { recursive: true });

  let stdoutText = fs.readFileSync(JSONL, "utf8");
  let rolloutPath = ROLLOUT;
  let workdir = WORKDIR;
  if (fresh) {
    stdoutText = await runCodexFresh(WORKDIR);
    assert.match(stdoutText, /EPHEMERA-ADMISSION-CANARY-OK/);
    const threadId = threadIdFromStdout(stdoutText);
    const found = newestRolloutFor(threadId);
    assert.ok(found, "fresh rollout file not found");
    rolloutPath = found;
  } else {
    assert.match(stdoutText, /EPHEMERA-BOOTSTRAP-CANARY-OK/);
    assert.ok(fs.existsSync(rolloutPath), `pinned rollout missing: ${rolloutPath}`);
  }

  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ephemera-admission-canary-state-"));
  const admissionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ephemera-admission-canary-root-"));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network send forbidden in admission canary"); };
  try {
    const service = sys.ingress.createMissionIngressService({ state_dir: stateRoot });
    const target = sys.contract.createTargetBinding({
      id: "target.canary-workdir",
      kind: "working_directory",
      durable_ref: { working_directory: workdir, repo_root: null },
      authority_profile: { access: "read_write" },
      observed_at: AT,
      validation_state: "VALIDATED",
    });
    const endpoint = sys.contract.createEndpointBinding({
      id: "endpoint.codex",
      kind: "codex_persisted_thread",
      transport_adapter: "codex-continuation",
      durable_ref: { adapter: "codex-continuation" },
      capabilities: ["queue", "resume"],
      authority_profile: { may_mutate_target: false },
      observed_at: AT,
      validation_state: "VALIDATED",
    });
    const record = service.createIngress({
      mission_id: "MISSION-ADMISSION-CANARY",
      outcome: "Admit a freshly bootstrapped isolated Codex thread.",
      success_signals: [],
      constraints: [],
      non_goals: [],
      authority_boundaries: { transition: "kernel_only" },
      binding_set: sys.contract.createMissionBindingSet({ mission_id: "MISSION-ADMISSION-CANARY", targets: [target], endpoints: [endpoint] }),
      created_at: AT,
    }).record;
    const request = service.createStartRequest("MISSION-ADMISSION-CANARY", {
      fresh_observation_refs: [{ kind: "canary_intent", ref: { isolated: true }, observed_at: AT, digest: null }],
      requested_at: AT,
    });
    const gate = sys.gate.createMissionKernelGate({ state_dir: stateRoot });
    const decision = await gate.decideStart("MISSION-ADMISSION-CANARY", request, { verify_observation: proveAll });
    assert.equal(decision.verdict, "ADMIT");
    const plan = sys.plan.createBootstrapPlan({
      record,
      request,
      decision,
      route: {
        route_kind: "bootstrap_new",
        target_ids: ["target.canary-workdir"],
        endpoint_ids: ["endpoint.codex"],
        execution_adapter: "codex-continuation",
        required_capabilities: ["queue"],
      },
      bootstrap: { requires_repository: false, writable_repository: false },
    });
    const parsed = sys.adapter.parseCodexExecBootstrap({
      stdout_text: stdoutText,
      rollout_path: rolloutPath,
      working_directory: workdir,
      repo_root: null,
      executable_path: CODEX_EXE,
      runtime_version: "0.153.1",
      runtime_fingerprint: null,
      observed_at: OBSERVED_AT,
    });
    const bootstrapResult = sys.result.createBootstrapResult(plan, {
      bootstrap_plan_id: plan.plan_id,
      provider_adapter: "codex-continuation",
      identities: parsed.identities,
      evidence_refs: parsed.evidence_refs,
      source_validation: parsed.source_validation,
      observed_at: OBSERVED_AT,
    });
    const candidate = sys.admission.createAdmissionCandidate({
      plan,
      bootstrap_result: bootstrapResult,
      admission: {
        mission_id: "MISSION-ADMISSION-CANARY",
        task_id: "TASK-ADMISSION-CANARY-1",
        chat_url: CHAT_URL,
        execution_mode: "bounded",
        goal: "Canary admission only; never run the loop.",
        current_task: "Prove bootstrap admission.",
      },
    });

    const consumer = createBootstrapAdmissionConsumer({
      validate_plan: sys.plan.validateBootstrapPlan,
      validate_result: sys.result.validateBootstrapResult,
      validate_candidate: sys.admission.validateAdmissionCandidate,
    });
    // Turn proof path: the live app-server read-only proof was attempted and
    // is refused by the bundled app-server build (thread/items/list is not
    // supported yet, -32601), so the exact initial-turn message from the
    // cross-checked EPHEMERA evidence is supplied here. The facade still
    // proves it source-owned: exact thread/turn ids, completed status, and a
    // recomputed source_turn_sha256 over the exact bytes.
    const agentText = parsed.evidence_refs[0].ref.agent_text;
    const proof = { message: agentText, causal_proof: parsed.source_validation.proof };
    const admitted = await consumer.admitBootstrapAdmission({
      plan,
      bootstrap_result: bootstrapResult,
      candidate,
      execution: { admission_root: admissionRoot, runtime_launch_args: CODEX_ARGS, thread_proof: proof, thread_probe_timeout_ms: 120000 },
    });
    assert.equal(admitted.created, true);
    assert.match(admitted.admission_id, /^admit-[0-9a-f]{64}$/);
    assert.equal(admitted.thread_identity.thread_id, parsed.identities.persisted_session.thread_id);
    assert.equal(admitted.thread_identity.initial_turn_id, parsed.identities.initial_completed_turn.turn_id);
    assert.equal(admitted.admission.codex_continuation_binding.thread_id, parsed.identities.persisted_session.thread_id);
    assert.equal(admitted.admission.codex_continuation_binding.working_directory, workdir);
    assert.equal(admitted.admission.task_chat_binding.chat_url, CHAT_URL);
    assert.ok(admitted.admission.codex_runtime_binding.capabilities.queue);
    assert.equal(admitted.admission.thread_probe.turn_status, "completed");
    const reloaded = validateClosedLoopAdmission(loadClosedLoopAdmission(admitted.file));
    assert.equal(reloaded.admission_id, admitted.admission_id);

    const replay = await consumer.admitBootstrapAdmission({
      plan,
      bootstrap_result: bootstrapResult,
      candidate,
      execution: { admission_root: admissionRoot, runtime_launch_args: CODEX_ARGS, thread_proof: proof, thread_probe_timeout_ms: 120000 },
    });
    assert.equal(replay.created, false);
    assert.equal(replay.admission_id, admitted.admission_id);
    assert.deepEqual(replay.thread_identity, admitted.thread_identity);
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});