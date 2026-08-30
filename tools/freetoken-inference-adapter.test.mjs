import assert from "node:assert/strict";
import test from "node:test";
import { createFreeTokenInferenceAdapter, createFreeTokenConfig, buildFreeTokenStartPlan, classifyFreeTokenFailure, classifyFreeTokenReadiness, redactFreeTokenLog, FREETOKEN_FAILURES } from "./freetoken-inference-adapter.mjs";

function fakeRequest(sequence = []) {
  const calls = [];
  return { calls, async request(url, options = {}) { calls.push({ url, options }); const next = sequence.shift(); if (next instanceof Error) throw next; if (typeof next === "function") return next(url, options); if (!next) throw new Error("unexpected fake request"); return next; } };
}

test("explicit configuration defaults disabled and enabled requires model", () => {
  assert.equal(createFreeTokenConfig({}, {}).enabled, false);
  assert.throws(() => createFreeTokenConfig({ enabled: true }, {}), /model/);
  assert.equal(createFreeTokenConfig({ enabled: true, model: "m" }).enabled, true);
});

test("start plan is explicit and provider-neutral", () => {
  const plan = buildFreeTokenStartPlan(createFreeTokenConfig({ enabled: true, model: "m", modelPath: "weights" }));
  assert.equal(plan.control.method, "POST"); assert.match(plan.control.url, /1900\/engine\/start$/); assert.deepEqual(plan.control.body, { model: "weights", port: 1919, args: [] }); assert.equal(plan.cli.args.at(-1), "1919");
});

test("readiness requires configured model in /v1/models or explicit ready field", () => {
  const config = createFreeTokenConfig({ enabled: true, model: "Qwen/model.gguf", modelPath: "Qwen/model.gguf" });
  assert.equal(classifyFreeTokenReadiness({ data: [{ id: "other" }] }, config).status, "NOT_READY");
  assert.equal(classifyFreeTokenReadiness({ data: [{ id: "model.gguf" }] }, config).status, "READY");
  assert.equal(classifyFreeTokenReadiness({ data: [] }, config).status, "NOT_READY");
  assert.equal(classifyFreeTokenReadiness({ error: "loading" }, config).status, "MALFORMED");
  assert.equal(classifyFreeTokenReadiness({}, config).status, "MALFORMED");
  assert.equal(classifyFreeTokenReadiness({ ready: true }, config).status, "READY");
});

test("health reports disabled and control/serve readiness", async () => {
  const disabled = createFreeTokenInferenceAdapter({ config: { enabled: false } });
  assert.equal((await disabled.health()).code, FREETOKEN_FAILURES.DISABLED);
  const f = fakeRequest([{ body: { status: "ok", engineRunning: true } }, { body: { status: "ok", model: "m" } }]);
  const adapter = createFreeTokenInferenceAdapter({ config: { enabled: true, model: "m" }, request: f.request });
  const h = await adapter.health();
  assert.equal(h.status, "READY"); assert.equal(f.calls.length, 2);
});

test("health truth table keeps control failures authoritative over serve readiness", async () => {
  const config = { enabled: true, model: "m", modelPath: "m" };
  const cases = [
    { name: "control error", control: { status: "ok", error: "engine failed" }, expected: "FAILED" },
    { name: "control malformed", control: {}, expected: "MALFORMED" },
    { name: "control stopping", control: { status: "stopping", engineRunning: true }, expected: "STOPPING" },
    { name: "control engine false with stale serve", control: { status: "ok", engineRunning: false }, expected: "NOT_READY" },
    { name: "control engine true with serve ready", control: { status: "ok", engineRunning: true }, expected: "READY" },
  ];
  for (const entry of cases) {
    const f = fakeRequest([{ body: entry.control }, { body: { data: [{ id: "m" }] } }]);
    const h = await createFreeTokenInferenceAdapter({ config, request: f.request }).health();
    assert.equal(h.status, entry.expected, entry.name);
    assert.equal(h.serve_readiness.status, "READY", entry.name);
  }
});

test("control unavailable may reuse a positively identified external serve without claiming ownership", async () => {
  const f = fakeRequest([new Error("ECONNREFUSED"), { body: { data: [{ id: "m" }] } }, new Error("ECONNREFUSED"), { body: { data: [{ id: "m" }] } }]);
  const adapter = createFreeTokenInferenceAdapter({ config: { enabled: true, model: "m", modelPath: "m" }, request: f.request, gpuProbe: () => ({ status: "CLEAR" }) });
  const h = await adapter.health();
  assert.equal(h.status, "READY");
  assert.equal(h.ownership, "EXTERNAL");
  assert.equal(h.owned, false);
  assert.equal(h.reason, "external_serve_ready_control_unavailable");
  const started = await adapter.start();
  assert.equal(started.status, "READY");
  assert.equal(started.owned, false);
  assert.equal(f.calls.some((call) => call.url.endsWith("/engine/start")), false);
});

test("configured model mismatch is never ready even when control reports a running engine", async () => {
  const f = fakeRequest([{ body: { status: "ok", engineRunning: true } }, { body: { data: [{ id: "other-model" }] } }]);
  const h = await createFreeTokenInferenceAdapter({ config: { enabled: true, model: "m", modelPath: "m" }, request: f.request }).health();
  assert.equal(h.status, "NOT_READY");
  assert.equal(h.control_readiness.status, "READY");
  assert.equal(h.serve_readiness.reason, "configured_model_absent");
});

test("start blocks explicit control failure instead of masking it with a stale serve", async () => {
  const f = fakeRequest([{ body: { status: "failed", error: "engine failed" } }, { body: { data: [{ id: "m" }] } }]);
  const adapter = createFreeTokenInferenceAdapter({ config: { enabled: true, model: "m", modelPath: "m" }, request: f.request, gpuProbe: () => ({ status: "CLEAR" }) });
  const result = await adapter.start();
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.code, FREETOKEN_FAILURES.SERVER_FAILURE);
  assert.equal(f.calls.some((call) => call.url.endsWith("/engine/start")), false);
});

test("GPU conflict blocks start before control API and does not stop anything", async () => {
  const f = fakeRequest();
  const adapter = createFreeTokenInferenceAdapter({ config: { enabled: true, model: "m" }, request: f.request, gpuProbe: () => ({ status: "CONFLICT", reason: "lm_studio" }) });
  const result = await adapter.start();
  assert.deepEqual({ status: result.status, code: result.code }, { status: "BLOCKED", code: FREETOKEN_FAILURES.UNAVAILABLE });
  assert.equal(f.calls.length, 0);
});

test("control start waits for serve readiness, executes, then stops owned engine", async () => {
  const f = fakeRequest([
    { body: { status: "ok", engineRunning: false } },
    new Error("ECONNREFUSED"),
    { body: { accepted: true } },
    { body: { status: "ok", model: "m" } },
    { body: { choices: [{ message: { content: "ok" } }] } },
    { body: { stopped: true } },
  ]);
  const events = []; const adapter = createFreeTokenInferenceAdapter({ config: { enabled: true, model: "m", readyTimeoutMs: 1000 }, request: f.request, gpuProbe: () => ({ status: "CLEAR" }), sleep: async () => {}, log: (x) => events.push(x) });
  const result = await adapter.run({ goal: "hello" });
  assert.equal(result.status, "PASS"); assert.equal(result.response.choices[0].message.content, "ok");
  assert.equal(f.calls.some((x) => x.url.endsWith("/engine/start")), true); assert.equal(f.calls.some((x) => x.url.endsWith("/engine/stop")), true); assert.equal(events[0].event, "freetoken_inference");
});

test("disabled, port collision, timeout, OOM, cancellation, and model failures classify deterministically", () => {
  assert.equal(classifyFreeTokenFailure(new Error("address already in use")), FREETOKEN_FAILURES.PORT_COLLISION);
  assert.equal(classifyFreeTokenFailure(new Error("CUDA out of memory")), FREETOKEN_FAILURES.GPU_OOM);
  assert.equal(classifyFreeTokenFailure(new Error("model load failed")), FREETOKEN_FAILURES.MODEL_LOAD_FAILURE);
  assert.equal(classifyFreeTokenFailure(new Error("request timeout")), FREETOKEN_FAILURES.TIMEOUT);
  assert.equal(classifyFreeTokenFailure(new Error("cancelled by caller")), FREETOKEN_FAILURES.CANCELLED);
});

test("structured logs redact credentials and bound long strings", () => {
  const value = redactFreeTokenLog({ token: "secret", nested: { authorization: "Bearer abc" }, text: "x".repeat(2000) });
  assert.equal(value.token, "[REDACTED]"); assert.equal(value.nested.authorization, "[REDACTED]"); assert.match(value.text, /TRUNCATED/);
});

test("serve readiness timeout returns bounded failure and cleanup", async () => {
  const f = fakeRequest([{ body: { status: "ok", engineRunning: false } }, new Error("ECONNREFUSED"), { body: { accepted: true } }, new Error("ECONNREFUSED")]);
  const adapter = createFreeTokenInferenceAdapter({ config: { enabled: true, model: "m", readyTimeoutMs: 1000 }, request: f.request, gpuProbe: () => ({ status: "CLEAR" }), sleep: async () => {} });
  const result = await adapter.start();
  assert.equal(result.status, "BLOCKED"); assert.equal(result.code, FREETOKEN_FAILURES.TIMEOUT); assert.equal(f.calls.some((x) => x.url.endsWith("/engine/stop")), true);
});

test("owned CLI process cleanup uses process tree while external workloads remain untouched", async () => {
  let killed = 0; const child = { pid: 77, once() {} }; const f = fakeRequest([{ body: { status: "ok", engineRunning: false } }, new Error("ECONNREFUSED"), { body: { status: "ok", model: "m" } }]);
  const adapter = createFreeTokenInferenceAdapter({ config: { enabled: true, model: "m", modelPath: "model", startMode: "cli" }, request: f.request, gpuProbe: () => ({ status: "CLEAR" }), spawnImpl: () => child, taskkill: () => { killed += 1; }, sleep: async () => {} });
  await adapter.start(); await adapter.stop(); assert.equal(killed, 1); assert.equal(f.calls.some((x) => x.url.endsWith("/engine/stop")), false);
});
