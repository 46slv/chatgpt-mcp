import assert from "node:assert/strict";
import test from "node:test";
import { captureCurrentChat, emptyRegistry, freezeTarget, isValidTargetAlias, loadRegistryLenient, parseChatGPTTargetUrl, resolveTarget, setTarget, validateRegistry, verifyFrozenTarget } from "./target-registry.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

function writeTempRegistry(value) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-target-test-"));
  const file = path.join(dir, "targets.json");
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), "utf8");
  return file;
}

const GOOD_URL = "https://chatgpt.com/c/6a9ba452-8b64-83e8-a7f6-e5704521360b";

function mixedRegistry() {
  return {
    schema_version: 1,
    default_target: "good",
    targets: {
      good: { transport: "chatgpt-web", title: "Good", chat_url: GOOD_URL, conversation_id: "6a9ba452-8b64-83e8-a7f6-e5704521360b" },
      "bad-url": { transport: "chatgpt-web", chat_url: "https://chatgpt.com/g/g-p-slug/c/ZZZ/project-extra/wrong" },
      "bad-id": { transport: "chatgpt-web", chat_url: GOOD_URL, conversation_id: "mismatch" },
      "bad-transport": { transport: "carrier-pigeon", chat_url: GOOD_URL },
      "../evil": { transport: "chatgpt-web", chat_url: GOOD_URL },
    },
  };
}

test("alias charset rejects traversal and unsafe names", () => {
  assert.equal(isValidTargetAlias("good"), true);
  assert.equal(isValidTargetAlias("a1._-"), true);
  for (const bad of ["", "../evil", "a/b", "__proto__", "_lead", null, undefined, 7]) {
    assert.equal(isValidTargetAlias(bad), false);
  }
});

test("lenient load isolates broken entries and keeps valid ones", () => {
  const file = writeTempRegistry(mixedRegistry());
  const { registry, errors, invalidAliases, invalidDefault } = loadRegistryLenient(file);
  assert.deepEqual(Object.keys(registry.targets), ["good"]);
  assert.equal(registry.default_target, "good");
  assert.equal(invalidDefault, null);
  assert.equal(errors.length, 4);
  for (const entry of errors) {
    assert.equal(entry.code, "TARGET_ENTRY_INVALID");
    assert.ok(entry.error.length <= 200);
  }
  assert.deepEqual([...invalidAliases].sort(), ["../evil", "bad-id", "bad-transport", "bad-url"]);
  assert.equal(resolveTarget({ explicitTarget: "good", registry }).target_id, "good");
});

test("lenient load nulls an invalid default instead of falling through", () => {
  const raw = mixedRegistry();
  raw.default_target = "bad-url";
  const file = writeTempRegistry(raw);
  const { registry, invalidDefault, errors } = loadRegistryLenient(file);
  assert.equal(registry.default_target, null);
  assert.equal(invalidDefault, "bad-url");
  assert.ok(errors.some((e) => e.code === "TARGET_DEFAULT_INVALID"));
});

test("lenient load fails closed on envelope corruption, not on entries", () => {
  assert.throws(() => loadRegistryLenient(writeTempRegistry("{oops")), /readable JSON/);
  assert.throws(() => loadRegistryLenient(writeTempRegistry({ schema_version: 99, targets: {} })), /schema_version/);
  const missing = loadRegistryLenient(path.join(os.tmpdir(), "devexec-target-test-no-such-dir", "targets.json"));
  assert.deepEqual(missing.registry.targets, {});
});

test("strict validation still rejects mixed registries (regression guard)", () => {
  assert.throws(() => validateRegistry(mixedRegistry()));
});
