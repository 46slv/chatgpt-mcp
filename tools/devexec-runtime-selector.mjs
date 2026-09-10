import { createFreeTokenInferenceAdapter } from "./freetoken-inference-adapter.mjs";
import { createLlamaCppInferenceAdapter } from "./llamacpp-inference-adapter.mjs";
import os from "node:os";
import path from "node:path";
import { runLocalWorkerTask, validateTaskContract, validateTaskBoundary } from "./local-worker-runtime.mjs";
import { logicalModelId } from "./freetoken-inference-adapter.mjs";
import { loadEphemeraRuntimePackage } from "./ephemera-runtime-materialize.mjs";
import {
  SPARK_PRIMARY_PROVIDER,
  SPARK_PRIMARY_RUNTIME,
} from "./devexec-local-defaults.mjs";

export const DEVEXEC_RUNTIME = Object.freeze({ DEFAULT: "default", CLOUD: "cloud", LOCAL: "local" });
export const DEVEXEC_PROVIDER = Object.freeze({ EXISTING: "existing", CHATGPT: "chatgpt", LM_STUDIO: "lmstudio", FREETOKEN: "freetoken", LLAMA_CPP: "llamacpp" });

export class DevExecRuntimeSelectionError extends Error {
  constructor(message, code = "INVALID_RUNTIME_SELECTION") {
    super(message);
    this.name = "DevExecRuntimeSelectionError";
    this.code = code;
  }
}

function fail(message, code) { throw new DevExecRuntimeSelectionError(message, code); }

/**
 * Resolve the runtime choice.  The omitted/default lane is the qualified
 * Spark/llama.cpp provider.  Cloud and legacy providers remain available only
 * when the caller names them; a disabled local lane is a hard stop rather than
 * a silent Qwen/LM Studio fallback.
 */
export function resolveDevExecRuntimeSelection(input = {}, env = process.env) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("runtime selection must be an object");
  const hasExplicit = input.runtime !== undefined || input.provider !== undefined || input.enabled !== undefined;
  const envRuntime = env.DEV_EXEC_RUNTIME == null ? null : String(env.DEV_EXEC_RUNTIME).trim().toLowerCase();
  const envProvider = env.DEV_EXEC_PROVIDER == null ? null : String(env.DEV_EXEC_PROVIDER).trim().toLowerCase();
  const implicitSpark = !hasExplicit && !envRuntime && !envProvider;
  const envDisabled = env.DEV_EXEC_LOCAL_ENABLED === "0";
  const enabled = input.enabled ?? (envDisabled ? false : (hasExplicit || envRuntime || envProvider ? true : implicitSpark));
  if (typeof enabled !== "boolean") fail("enabled must be boolean");
  const runtime = String(input.runtime ?? envRuntime ?? (implicitSpark ? SPARK_PRIMARY_RUNTIME : DEVEXEC_RUNTIME.DEFAULT)).trim().toLowerCase();
  const providerValue = input.provider ?? envProvider ?? (implicitSpark ? SPARK_PRIMARY_PROVIDER : null);
  const provider = providerValue == null ? null : String(providerValue).trim().toLowerCase();

  if (!Object.values(DEVEXEC_RUNTIME).includes(runtime)) fail(`unsupported runtime: ${runtime}`, "UNSUPPORTED_RUNTIME");
  // Disabled is a hard stop. It never constructs or starts a provider and does
  // not route back to an old model implicitly.
  if (!enabled) {
    return Object.freeze({ runtime: runtime === DEVEXEC_RUNTIME.DEFAULT ? SPARK_PRIMARY_RUNTIME : runtime, provider: provider || SPARK_PRIMARY_PROVIDER, explicit: hasExplicit, enabled: false });
  }
  if (runtime === DEVEXEC_RUNTIME.DEFAULT) {
    if (provider && provider !== DEVEXEC_PROVIDER.EXISTING) fail("default runtime accepts only the explicit existing compatibility provider", "UNSUPPORTED_PROVIDER");
    return Object.freeze({ runtime: DEVEXEC_RUNTIME.DEFAULT, provider: DEVEXEC_PROVIDER.EXISTING, explicit: hasExplicit, enabled: true });
  }
  if (runtime === DEVEXEC_RUNTIME.LOCAL) {
    if (![DEVEXEC_PROVIDER.FREETOKEN, DEVEXEC_PROVIDER.LM_STUDIO, DEVEXEC_PROVIDER.LLAMA_CPP].includes(provider)) {
      fail("local runtime requires an explicit supported provider", "UNSUPPORTED_PROVIDER");
    }
    return Object.freeze({ runtime, provider, explicit: hasExplicit || Boolean(envRuntime || envProvider), enabled: true });
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
  if ((selection.runtime === DEVEXEC_RUNTIME.DEFAULT && selection.provider === DEVEXEC_PROVIDER.EXISTING) || selection.provider === DEVEXEC_PROVIDER.EXISTING) {
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
  if (selection.provider === DEVEXEC_PROVIDER.LLAMA_CPP) {
    const adapter = adapters.llamacpp || createLlamaCppInferenceAdapter(options.llamacpp || {});
    if (!adapter || typeof adapter.run !== "function") fail("llama.cpp adapter is required", "ADAPTER_MISSING");
    return adapter;
  }
  if (selection.provider === DEVEXEC_PROVIDER.LM_STUDIO) {
    const adapter = adapters.lmstudio || adapters.local;
    if (!adapter || typeof adapter.run !== "function") fail("LM Studio adapter is required", "ADAPTER_MISSING");
    return adapter;
  }
  fail(`unsupported provider: ${selection.provider}`, "UNSUPPORTED_PROVIDER");
}

function defaultRuntimeStateBase(env = process.env) {
  const base = env?.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.resolve(base, "ChatGPTMCPProbe", "ephemera-system-runtime");
}

function defaultRecoveryStateDir(env = process.env) {
  return path.join(defaultRuntimeStateBase(env), "recovery");
}

function defaultLeaseStateDir(env = process.env) {
  return path.join(defaultRuntimeStateBase(env), "provider-lease");
}

function providerLeaseRequest(adapter, provider = "freetoken") {
  const config = adapter?.config || {};
  let servePort = 1919;
  try { servePort = Number(new URL(config.serveUrl || "http://127.0.0.1:1919").port || 1919); } catch { /* use fixed default */ }
  return {
    provider: String(adapter?.identity?.provider || provider || "freetoken"),
    deviceIndex: Number.isInteger(adapter?.resolvedDeviceIndex) ? adapter.resolvedDeviceIndex : Number.isInteger(config.deviceIndex) ? config.deviceIndex : 0,
    servePort,
    modelId: logicalModelId(String(config.model || adapter?.identity?.model || "unconfigured"), "unconfigured"),
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
 * Explicit local runs have a System-owned lifecycle envelope.  It
 * intentionally has no routing, takeover, resume, or process-kill behavior:
 * a non-clean recovery record or lease simply blocks this one local run.
 */
export function createDevExecEntrypoint({
  selection,
  env = process.env,
  adapters = {},
  freetoken = {},
  llamacpp = {},
  recoveryStateDir = null,
  leaseStateDir = null,
  admissionStateDir = null,
  runtimeCacheDir = null,
} = {}) {
  const resolved = resolveDevExecRuntimeSelection(selection || {}, env);
  const adapter = adapterFor(resolved, adapters, { freetoken, llamacpp });
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
      // Journal, admission, and provider lease artifacts belong to the System
      // package and remain outside the worker's worktree. A missing package is
      // an explicit BLOCKED condition; the legacy source lifecycle is never a
      // fallback.
      const recoveryDir = path.resolve(recoveryStateDir || defaultRecoveryStateDir(env));
      const leaseDir = path.resolve(leaseStateDir || defaultLeaseStateDir(env));
      const admissionDir = admissionStateDir ? path.resolve(admissionStateDir) : null;
      assertExternalRuntimeStateDir(recoveryDir, task.worktree, "recovery state directory");
      assertExternalRuntimeStateDir(leaseDir, task.worktree, "lease state directory");
      if (admissionDir) assertExternalRuntimeStateDir(admissionDir, task.worktree, "admission state directory");

      // The exact-pinned System facade is the only local lifecycle authority.
      // There is deliberately no runtime/factory/options injection here: a
      // caller cannot bypass materialization or re-introduce source-owned
      // recovery, admission, or lease implementations.
      const runtime = await loadEphemeraRuntimePackage({ cacheDir: runtimeCacheDir || env?.EPHEMERA_RUNTIME_CACHE_DIR || undefined, worktree: task.worktree });
      if (!runtime || typeof runtime.createSystemLocalRuntimeLifecycle !== "function") {
        fail("materialized EPHEMERA runtime package is missing its lifecycle facade", "EPHEMERA_EXPORTS_MISMATCH");
      }
      const lifecycle = runtime.createSystemLocalRuntimeLifecycle({
        recoveryStateDir: recoveryDir,
        leaseStateDir: leaseDir,
        ...(admissionDir ? { admissionStateDir: admissionDir } : {}),
        beforeProviderLease: async ({ signal }) => {
          // This hook is the source-owned ordering seam: boundary validation
          // and GPU policy run after System PREFLIGHT but before lease acquire.
          validateTaskBoundary(task);
          if (typeof adapter.gpuGate === "function") {
            const gpu = await adapter.gpuGate(signal);
            if (!gpu || gpu.status !== "CLEAR") {
              throw new DevExecRuntimeSelectionError("target GPU is unavailable; existing workload was not changed", "GPU_UNAVAILABLE");
            }
          }
        },
      });
      if (!lifecycle || typeof lifecycle.run !== "function") fail("materialized EPHEMERA runtime lifecycle is invalid", "EPHEMERA_EXPORTS_MISMATCH");

      const lifecycleOutcome = await lifecycle.run({
        runId: context.runId,
        worktree: task.worktree,
        leaseRequest: providerLeaseRequest(adapter, resolved.provider),
        signal: context.signal || null,
        onLifecycle: context.onLifecycle || null,
        execute: async ({ runId, signal, onLifecycle }) => {
          const lifecycleAdapter = {
            ...adapter,
            async run(input, runtimeContext = {}) {
              const workerLifecycle = runtimeContext.onLifecycle;
              return adapter.run(input, {
                ...runtimeContext,
                onLifecycle: (event) => {
                  workerLifecycle?.(event);
                  onLifecycle?.(event);
                },
              });
            },
          };
          return runLocalWorkerTask(task, {
            adapter: lifecycleAdapter,
            runTest: context.runTest,
            now: context.now,
            failureGuard: context.failureGuard,
            signal,
            runLedgerDir: context.runLedgerDir,
            runId,
            selection: resolved,
            ledgerWriter: context.ledgerWriter,
            cleanupTimeoutMs: context.cleanupTimeoutMs,
          });
        },
      });
      return lifecycleOutcome;
    },
    health: typeof adapter.health === "function" ? adapter.health.bind(adapter) : async () => ({ status: "UNKNOWN" }),
    stop: typeof adapter.stop === "function" ? adapter.stop.bind(adapter) : async () => ({ status: "STOPPED" }),
  });
}

export function createRuntimeSelector(options = {}) { return createDevExecEntrypoint(options); }
