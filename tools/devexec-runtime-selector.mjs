import { createFreeTokenInferenceAdapter } from "./freetoken-inference-adapter.mjs";
import { runLocalWorkerTask, validateTaskContract } from "./local-worker-runtime.mjs";

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
export function createDevExecEntrypoint({ selection, env = process.env, adapters = {}, freetoken = {} } = {}) {
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
      return runLocalWorkerTask(task, { adapter, runTest: context.runTest, now: context.now });
    },
    health: typeof adapter.health === "function" ? adapter.health.bind(adapter) : async () => ({ status: "UNKNOWN" }),
    stop: typeof adapter.stop === "function" ? adapter.stop.bind(adapter) : async () => ({ status: "STOPPED" }),
  });
}

export function createRuntimeSelector(options = {}) { return createDevExecEntrypoint(options); }
