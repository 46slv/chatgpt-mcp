import { createFreeTokenInferenceAdapter } from "./freetoken-inference-adapter.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runLocalWorkerTask, validateTaskContract, validateTaskBoundary } from "./local-worker-runtime.mjs";
import { logicalModelId } from "./freetoken-inference-adapter.mjs";
import { createRecoveryJournal, scanRecoveryState } from "./local-runtime-recovery-journal.mjs";
import { createProviderLeaseManager } from "./local-provider-lease.mjs";

export const DEVEXEC_RUNTIME = Object.freeze({ DEFAULT: "default", CLOUD: "cloud", LOCAL: "local" });
export const DEVEXEC_PROVIDER = Object.freeze({ EXISTING: "existing", CHATGPT: "chatgpt", LM_STUDIO: "lmstudio", FREETOKEN: "freetoken" });

export class DevExecRuntimeSelectionError extends Error {
  constructor(message, code = "INVALID_RUNTIME_SELECTION") {
    super(message);
    this.name = "DevExecRuntimeSelectionError";
    this.code = code;
  }
}

function fail(message, code) { throw new DevExecRuntimeSelectionError(message, code); }

/**
 * Resolve an explicit runtime choice. The default is deliberately opaque and
 * keeps the caller's existing Cloud/LM Studio adapter untouched. Local
 * FreeToken is entered only when both runtime and provider are explicit.
 */
export function resolveDevExecRuntimeSelection(input = {}, env = process.env) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("runtime selection must be an object");
  const hasExplicit = input.runtime !== undefined || input.provider !== undefined || input.enabled !== undefined;
  const enabled = input.enabled ?? (hasExplicit ? true : env.DEV_EXEC_LOCAL_ENABLED === "1");
  if (typeof enabled !== "boolean") fail("enabled must be boolean");
  const runtime = String(input.runtime ?? env.DEV_EXEC_RUNTIME ?? DEVEXEC_RUNTIME.DEFAULT).trim().toLowerCase();
  const providerValue = input.provider ?? env.DEV_EXEC_PROVIDER;
  const provider = providerValue == null ? null : String(providerValue).trim().toLowerCase();

  if (!Object.values(DEVEXEC_RUNTIME).includes(runtime)) fail(`unsupported runtime: ${runtime}`, "UNSUPPORTED_RUNTIME");
  // Disabled is an explicit fail-safe back to the established path. It never
  // constructs or starts a local provider.
  if (!enabled || runtime === DEVEXEC_RUNTIME.DEFAULT) {
    return Object.freeze({ runtime: DEVEXEC_RUNTIME.DEFAULT, provider: DEVEXEC_PROVIDER.EXISTING, explicit: hasExplicit, enabled: false });
  }
  if (runtime === DEVEXEC_RUNTIME.LOCAL) {
    if (![DEVEXEC_PROVIDER.FREETOKEN, DEVEXEC_PROVIDER.LM_STUDIO].includes(provider)) {
      fail("local runtime requires an explicit supported provider", "UNSUPPORTED_PROVIDER");
    }
    return Object.freeze({ runtime, provider, explicit: true, enabled: true });
  }
  if (runtime === DEVEXEC_RUNTIME.CLOUD) {
    if (provider && ![DEVEXEC_PROVIDER.CHATGPT, DEVEXEC_PROVIDER.EXISTING].includes(provider)) {
      fail(`unsupported cloud provider: ${provider}`, "UNSUPPORTED_PROVIDER");
    }
    return Object.freeze({ runtime, provider: provider || DEVEXEC_PROVIDER.EXISTING, explicit: true, enabled: true });
  }
  fail(`unsupported runtime: ${runtime}`, "UNSUPPORTED_RUNTIME");
}

export const selectDevExecRuntime = resolveDevExecRuntimeSelection;
export const resolveRuntimeSelector = resolveDevExecRuntimeSelection;

function adapterFor(selection, adapters = {}, options = {}) {
  if (selection.runtime === DEVEXEC_RUNTIME.DEFAULT || selection.provider === DEVEXEC_PROVIDER.EXISTING) {
    if (!adapters.default || typeof adapters.default.run !== "function") fail("default adapter is required", "ADAPTER_MISSING");
    return adapters.default;
  }
  if (selection.runtime === DEVEXEC_RUNTIME.CLOUD) {
    const adapter = adapters.cloud || adapters.default;
    if (!adapter || typeof adapter.run !== "function") fail("cloud adapter is required", "ADAPTER_MISSING");
    return adapter;
  }
  if (selection.provider === DEVEXEC_PROVIDER.FREETOKEN) {
    const adapter = adapters.freetoken || createFreeTokenInferenceAdapter(options.freetoken || {});
    if (!adapter || typeof adapter.run !== "function") fail("FreeToken adapter is required", "ADAPTER_MISSING");
    return adapter;
  }
  if (selection.provider === DEVEXEC_PROVIDER.LM_STUDIO) {
    const adapter = adapters.lmstudio || adapters.local;
    if (!adapter || typeof adapter.run !== "function") fail("LM Studio adapter is required", "ADAPTER_MISSING");
    return adapter;
  }
  fail(`unsupported provider: ${selection.provider}`, "UNSUPPORTED_PROVIDER");
}

/**
 * Small facade seam used by DevExec callers. Provider lifecycle remains owned
 * by the selected adapter; this object only validates/dispatches and then
 * returns the parent-reverified local result.
 */
function safeJournalAppend(journal, state, data = {}) {
  if (!journal) return;
  journal.append(state, data);
}

function finishJournal(journal, resultStatus = "FAILED", releaseStatus = "NOT_ATTEMPTED") {
  if (!journal) return;
  const last = journal.readEvents().at(-1)?.state;
  if (last === "INFERENCE") { safeJournalAppend(journal, "POSTFLIGHT"); safeJournalAppend(journal, "TEST"); }
  else if (["PREFLIGHT", "LEASE_ACQUIRED", "PROVIDER_STARTED"].includes(last)) safeJournalAppend(journal, "CLEANUP");
  const current = journal.readEvents().at(-1)?.state;
  if (current === "TEST") safeJournalAppend(journal, "CLEANUP");
  if (journal.readEvents().at(-1)?.state === "CLEANUP" || journal.readEvents().at(-1)?.state === "RUN_CREATED") {
    safeJournalAppend(journal, "TERMINAL", { result_status: resultStatus, reason_code: releaseStatus });
  }
}

function providerLeaseRequest(adapter, runId) {
  const config = adapter?.config || {};
  let servePort = 1919;
  try { servePort = Number(new URL(config.serveUrl || "http://127.0.0.1:1919").port || 1919); } catch { /* use fixed default */ }
  return {
    provider: "freetoken",
    deviceIndex: Number.isInteger(config.deviceIndex) ? config.deviceIndex : 0,
    servePort,
    modelId: logicalModelId(String(config.model || adapter?.identity?.model || "unconfigured"), "unconfigured"),
    runId,
  };
}

function assertExternalRuntimeStateDir(stateDir, worktree, label) {
  if (!stateDir) return;
  const relative = path.relative(path.resolve(worktree), path.resolve(stateDir));
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new DevExecRuntimeSelectionError(`${label} must be outside the task worktree`, "RUNTIME_STATE_INSIDE_WORKTREE");
  }
}

/**
 * Explicit FreeToken runs have a small parent-owned lifecycle envelope.  It
 * intentionally has no routing, takeover, resume, or process-kill behavior:
 * a non-clean recovery record or lease simply blocks this one local run.
 */
export function createDevExecEntrypoint({ selection, env = process.env, adapters = {}, freetoken = {}, recoveryStateDir = null, leaseStateDir = null, leaseManagerFactory = createProviderLeaseManager } = {}) {
  const resolved = resolveDevExecRuntimeSelection(selection || {}, env);
  const adapter = adapterFor(resolved, adapters, { freetoken });
  const local = resolved.runtime === DEVEXEC_RUNTIME.LOCAL;
  return Object.freeze({
    selection: resolved,
    identity: Object.freeze({ runtime: resolved.runtime, provider: resolved.provider }),
    async run(task, context = {}) {
      if (!local) return adapter.run(task, context);
      // Local execution is contract-first. runLocalWorkerTask performs the
      // exact repo/worktree/base checks, test command execution, and parent
      // recomputation of changes before exposing the result.
      validateTaskContract(task, { verifyGit: false });
      if (adapter?.config?.idleStopMs > 0) throw new DevExecRuntimeSelectionError("idleStopMs must be 0 for the leased local runtime", "IDLE_STOP_UNSUPPORTED");
      // Journal/lease artifacts belong to the parent, not the worker's
      // worktree. Otherwise their own terminal event becomes an untrusted
      // worker diff during parent postflight.
      assertExternalRuntimeStateDir(recoveryStateDir, task.worktree, "recovery state directory");
      assertExternalRuntimeStateDir(leaseStateDir, task.worktree, "lease state directory");
      const runId = context.runId || crypto.randomUUID();
      let journal = null;
      let manager = null;
      let lease = null;
      let leaseStatus = "NOT_ACQUIRED";
      let journalResult = "FAILED";
      try {
        // This scan is read-only.  Absence is a new state directory; any
        // nonterminal/malformed evidence is an explicit stop rather than an
        // automatic recovery attempt.
        if (recoveryStateDir && fs.existsSync(recoveryStateDir)) {
          const scan = scanRecoveryState(recoveryStateDir);
          if (scan.status !== "CLEAN") throw new DevExecRuntimeSelectionError("recovery state needs attention; local run was not started", "RECOVERY_NEEDS_ATTENTION");
        }
        if (recoveryStateDir) journal = createRecoveryJournal({ stateDir: recoveryStateDir, runId });
        // Parent boundary validation happens before the GPU gate/lease. The
        // worker repeats this immediately before execution to catch drift.
        validateTaskBoundary(task);
        safeJournalAppend(journal, "PREFLIGHT");
        if (typeof adapter.gpuGate === "function") {
          const gpu = await adapter.gpuGate(context.signal);
          if (!gpu || gpu.status !== "CLEAR") throw new DevExecRuntimeSelectionError("target GPU is unavailable; existing workload was not changed", "GPU_UNAVAILABLE");
        }
        if (leaseStateDir) {
          manager = leaseManagerFactory({ stateDir: leaseStateDir });
          const acquired = manager.acquire(providerLeaseRequest(adapter, runId));
          if (acquired.status !== "ACQUIRED") throw new DevExecRuntimeSelectionError("local provider lease is held or needs attention", acquired.status);
          lease = acquired.lease;
          leaseStatus = "ACQUIRED";
          safeJournalAppend(journal, "LEASE_ACQUIRED");
        }
        const journalAdapter = {
          ...adapter,
          async run(input, runtimeContext = {}) {
            const parentLifecycle = runtimeContext.onLifecycle;
            const onLifecycle = (event) => {
              if (event === "start_start") safeJournalAppend(journal, "PROVIDER_STARTED");
              if (event === "inference_start") safeJournalAppend(journal, "INFERENCE");
              parentLifecycle?.(event);
            };
            return adapter.run(input, { ...runtimeContext, onLifecycle });
          },
        };
        const outcome = await runLocalWorkerTask(task, { adapter: journalAdapter, runTest: context.runTest, now: context.now, failureGuard: context.failureGuard, signal: context.signal, runLedgerDir: context.runLedgerDir, runId, selection: resolved, ledgerWriter: context.ledgerWriter, cleanupTimeoutMs: context.cleanupTimeoutMs });
        journalResult = outcome?.result?.status || "FAILED";
        return outcome;
      } finally {
        if (lease && manager) {
          const released = manager.release(lease);
          leaseStatus = released.status;
        }
        // Journal completion is compact lifecycle evidence only.  A failure
        // here must not make the worker result look successful; callers still
        // receive the parent-recomputed result above.
        try { finishJournal(journal, journalResult, leaseStatus); } catch { /* preserve the durable nonterminal record for scan */ }
      }
    },
    health: typeof adapter.health === "function" ? adapter.health.bind(adapter) : async () => ({ status: "UNKNOWN" }),
    stop: typeof adapter.stop === "function" ? adapter.stop.bind(adapter) : async () => ({ status: "STOPPED" }),
  });
}

export function createRuntimeSelector(options = {}) { return createDevExecEntrypoint(options); }
