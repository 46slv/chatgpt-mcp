import assert from "node:assert/strict";
import test from "node:test";
import { createFreeTokenInferenceAdapter, createFreeTokenConfig, classifyFreeTokenFailure, redactFreeTokenLog, FREETOKEN_FAILURES } from "./freetoken-inference-adapter.mjs";

function fakeRequest(sequence = []) {
  const calls = [];
  return { calls, async request(url, options = {}) { calls.push({ url, options }); const next = sequence.shift(); if (next instanceof Error) throw next; if (typeof next === "function") return next(url, options); if (!next) throw new Error("unexpected fake request"); return next; } };
}

test("explicit configuration defaults disabled and enabled requires model", () => {
  assert.equal(createFreeTokenConfig({}, {}).enabled, false);
  assert.throws(() => createFreeTokenConfig({ enabled: true }, {}), /model/);
  assert.equal(createFreeTokenConfig({ enabled: true, model: "m" }).enabled, true);
});

test("health reports disabled and control/serve readiness", async () => {
  const disabled = createFreeTokenInferenceAdapter({ config: { enabled: false } });
  assert.equal((await disabled.health()).code, FREETOKEN_FAILURES.DISABLED);
  const f = fakeRequest([{ body: { status: "ok", engineRunning: true } }, { body: { status: "ok", model: "m" } }]);
  const adapter = createFreeTokenInferenceAdapter({ config: { enabled: true, model: "m" }, request: f.request });
  const h = await adapter.health();
  assert.equal(h.status, "READY"); assert.equal(f.calls.length, 2);
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
