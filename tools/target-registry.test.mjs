import assert from "node:assert/strict";
import test from "node:test";
import { captureCurrentChat, emptyRegistry, freezeTarget, parseChatGPTTargetUrl, resolveTarget, setTarget, verifyFrozenTarget } from "./target-registry.mjs";
import { runIterativeLocalWorker } from "./local-worker-iterative-runner.mjs";

test("prepared ChatGPT URL parser accepts direct and project-scoped canonical forms", () => {
  assert.deepEqual(parseChatGPTTargetUrl("https://chatgpt.com/c/abc-123"), { chat_url: "https://chatgpt.com/c/abc-123", conversation_id: "abc-123" });
  assert.deepEqual(parseChatGPTTargetUrl("https://chatgpt.com/g/g-p-6a8b6b69fcfc8191b50f7cea8f0ab75a-knotfield-davinci-resolve-field-nodes/c/6a909505-987c-83ee-90fc-487044966e13"), {
    chat_url: "https://chatgpt.com/g/g-p-6a8b6b69fcfc8191b50f7cea8f0ab75a-knotfield-davinci-resolve-field-nodes/c/6a909505-987c-83ee-90fc-487044966e13",
    conversation_id: "6a909505-987c-83ee-90fc-487044966e13",
  });
  for (const value of [
    "",
    " https://chatgpt.com/c/abc-123",
    "https://chatgpt.com/c/abc-123 ",
    "http://chatgpt.com/c/abc-123",
    "https://www.chatgpt.com/c/abc-123",
    "https://chatgpt.com:443/c/abc-123",
    "https://user:pass@chatgpt.com/c/abc-123",
    "https://chatgpt.com/c/abc-123/",
    "https://chatgpt.com/c/abc-123/extra",
    "https://chatgpt.com/c/abc-123?x=1",
    "https://chatgpt.com/c/abc-123#fragment",
    "https://chatgpt.com/c/",
    "https://chatgpt.com/c/abc_123",
    "https://chatgpt.com/g/g-p-slug",
    "https://chatgpt.com/g/g-p-slug/",
    "https://chatgpt.com/g/g-p-slug/c/",
    "https://chatgpt.com/g/g-p-slug/c/abc-123/extra",
    "https://chatgpt.com/g/g-p-slug/c/abc-123/",
    "https://chatgpt.com/g/g_p_slug/c/abc-123",
    "https://chatgpt.com/g/../c/abc-123",
    "https://chatgpt.com/g/g-p-slug/c/../abc-123",
    "https://chatgpt.com/g/g-p-slug%2Fc/abc-123",
    "https://chatgpt.com/g/g-p-slug/c/abc%2D123",
  ]) assert.throws(() => parseChatGPTTargetUrl(value));
});

test("set and resolve retain schema-v1 canonical URL and conversation identity", () => {
  const registry = emptyRegistry();
  setTarget(registry, "prepared", "https://chatgpt.com/c/abc-123", { title: "Prepared" });
  assert.deepEqual(registry.targets.prepared, { transport: "chatgpt-web", title: "Prepared", chat_url: "https://chatgpt.com/c/abc-123", conversation_id: "abc-123" });
  assert.deepEqual(resolveTarget({ explicitTarget: "prepared", registry }), { target_id: "prepared", transport: "chatgpt-web", chat_url: "https://chatgpt.com/c/abc-123", conversation_id: "abc-123", source: "explicit" });
});

test("set, resolve, freeze, and verify preserve project-scoped URL identity", () => {
  const url = "https://chatgpt.com/g/g-p-slug/c/project-123";
  const registry = emptyRegistry();
  setTarget(registry, "project-chat", url);
  assert.equal(resolveTarget({ explicitTarget: "project-chat", registry }).chat_url, url);
  const frozen = freezeTarget({ target_id: "project-chat", chat_url: url, source: "explicit" }, { frozenAt: "2026-08-29T00:00:00.000Z" });
  assert.equal(frozen.url, url);
  assert.equal(frozen.conversation_id, "project-123");
  assert.deepEqual(verifyFrozenTarget(frozen, { registry }), frozen);
});

test("captureCurrentChat recognizes a project-scoped CDP tab and preserves its URL", async () => {
  const url = "https://chatgpt.com/g/g-p-slug/c/captured-123";
  const previousFetch = globalThis.fetch;
  const previousWebSocket = globalThis.WebSocket;
  class FakeWebSocket {
    constructor() { this.listeners = {}; queueMicrotask(() => { for (const fn of this.listeners.open || []) fn(); }); }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    send() {
      const message = { id: 1, result: { result: { value: JSON.stringify({ href: url, title: "Project chat", visibility: "visible", focused: true }) } } };
      for (const fn of this.listeners.message || []) fn({ data: JSON.stringify(message) });
    }
    close() {}
  }
  globalThis.fetch = async () => ({ ok: true, json: async () => [{ type: "page", url, webSocketDebuggerUrl: "ws://fake" }] });
  globalThis.WebSocket = FakeWebSocket;
  try {
    const captured = await captureCurrentChat();
    assert.equal(captured.transport, "chatgpt-web");
    assert.equal(captured.chat_url, url);
    assert.equal(captured.conversation_id, "captured-123");
    assert.equal(captured.title, "Project chat");
    assert.equal(typeof captured.captured_at, "string");
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.WebSocket = previousWebSocket;
  }
});

test("run target is frozen before consultation and planner cannot replace it", async () => {
  const target = freezeTarget({ target_id: "prepared", chat_url: "https://chatgpt.com/c/abc-123", source: "explicit" }, { frozenAt: "2026-08-29T00:00:00.000Z" });
  let consultedTarget = null; let plannerCalled = false;
  const outcome = await runIterativeLocalWorker({ mission: "consult", target, maxRounds: 2,
    plan: async ({ round }) => { plannerCalled = true; return round === 1 ? { type: "REQUEST_CONSULTATION", prompt: "ordinary" } : { type: "COMPLETE", summary: "done" }; },
    execute: async () => ({ status: "PASS" }),
    consult: async (prompt, requestId, immutableTarget) => { consultedTarget = immutableTarget; return { status: "RESPONSE_RECEIVED", request_id: requestId, response_evidence: { trusted: false, text: prompt } }; },
  });
  assert.equal(plannerCalled, true);
  assert.equal(outcome.status, "DONE");
  assert.strictEqual(consultedTarget, target);
  assert.equal(Object.isFrozen(consultedTarget), true);
});

test("resume verification fails closed when prepared alias is missing or changed", () => {
  const frozen = freezeTarget({ target_id: "prepared", chat_url: "https://chatgpt.com/c/old-1", source: "explicit" }, { frozenAt: "2026-08-29T00:00:00.000Z" });
  const missing = emptyRegistry();
  assert.throws(() => verifyFrozenTarget(frozen, { registry: missing }), error => error.code === "TARGET_FROZEN_ALIAS_UNAVAILABLE");
  const changed = emptyRegistry(); setTarget(changed, "prepared", "https://chatgpt.com/c/new-2");
  assert.throws(() => verifyFrozenTarget(frozen, { registry: changed }), error => error.code === "TARGET_FROZEN_MISMATCH");
  const same = emptyRegistry(); setTarget(same, "prepared", "https://chatgpt.com/c/old-1");
  assert.deepEqual(verifyFrozenTarget(frozen, { registry: same }), frozen);
});
