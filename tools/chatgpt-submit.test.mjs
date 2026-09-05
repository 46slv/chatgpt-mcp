import assert from "node:assert/strict";
import test from "node:test";
import {
  submitComposedPrompt,
  captureSendBaseline,
  normalizeComposedText,
  cleanResponseText,
  decidePollCompletion,
} from "../dist/chatgpt.js";

const TARGET_URL = "https://chatgpt.com/c/prepared-submit-1";
const PROMPT = "Reply with exactly DIAG3-OK";

function submitFake(options = {}) {
  const turns = (options.turns ?? ["first user", "first assistant"]).map((text, index) => ({ testid: "conversation-turn-" + (index + 1), text }));
  const state = {
    sent: false,
    sentText: options.sentTurnText !== undefined ? options.sentTurnText : PROMPT,
    composer: options.composer !== undefined ? options.composer : PROMPT,
    enterPresses: 0,
    focusCalls: 0,
    clicks: 0,
    driftAfterCalls: options.driftAfterCalls ?? -1,
    urlCalls: 0,
  };
  const doSend = () => { state.sent = true; state.composer = ""; };
  const count = () => turns.length + (state.sent ? 1 : 0);
  const turnAt = (i) => {
    if (i < turns.length) return turns[i];
    if (i === turns.length && state.sent) return { testid: "conversation-turn-" + (i + 1), text: state.sentText };
    throw new Error("no such turn");
  };
  const page = {
    url: () => {
      state.urlCalls += 1;
      if (state.driftAfterCalls >= 0 && state.urlCalls > state.driftAfterCalls) return "https://chatgpt.com/c/other-conversation";
      return TARGET_URL;
    },
    locator: (selector) => ({
      first: () => ({
        focus: async () => { state.focusCalls += 1; },
        innerText: async () => state.composer,
        click: async () => {},
      }),
      nth: (i) => ({
        click: async () => {
          state.clicks += 1;
          if (options.click === "throw") throw new Error("intercepts pointer events");
          if (options.clickSends) doSend();
        },
        isVisible: async () => true,
        innerText: async () => turnAt(i).text,
        getAttribute: async (name) => (name === "data-testid" ? turnAt(i).testid : null),
      }),
      count: async () => count(),
    }),
    keyboard: {
      press: async (key) => {
        if (key !== "Enter") throw new Error("unexpected key " + key);
        state.enterPresses += 1;
        if (options.enterSends !== false) doSend();
      },
    },
  };
  return { page, state };
}

const FAST = { clickAckMs: 5, enterAckMs: 5 };

test("baseline captures exact url, turn count, and last turn testid", async () => {
  const { page } = submitFake();
  const baseline = await captureSendBaseline(page);
  assert.equal(baseline.url, TARGET_URL);
  assert.equal(baseline.turnCount, 2);
  assert.equal(baseline.lastTurnTestId, "conversation-turn-2");
});

test("composed text comparison ignores surrounding whitespace only", () => {
  assert.equal(normalizeComposedText("  hello   world  "), "hello world");
  assert.equal(normalizeComposedText(PROMPT), PROMPT);
});

test("button click with real send uses zero Enter fallback", async () => {
  const { page, state } = submitFake({ clickSends: true });
  const baseline = await captureSendBaseline(page);
  const ack = await submitComposedPrompt(page, PROMPT, baseline, FAST);
  assert.equal(ack.userTurnIndex, 2);
  assert.equal(ack.ackTurnCount, 3);
  assert.equal(ack.userTurnText, PROMPT);
  assert.equal(state.enterPresses, 0);
});

test("click without send plus composer residue falls back to exactly one Enter", async () => {
  const { page, state } = submitFake({});
  const baseline = await captureSendBaseline(page);
  const ack = await submitComposedPrompt(page, PROMPT, baseline, FAST);
  assert.equal(ack.userTurnIndex, 2);
  assert.equal(ack.ackTurnCount, 3);
  assert.equal(state.enterPresses, 1);
  assert.equal(state.focusCalls, 1);
  const again = await captureSendBaseline(page);
  assert.equal(again.turnCount, 3);
});

test("cleared composer without ack never presses Enter and fails closed", async () => {
  const { page, state } = submitFake({ composer: "" });
  const baseline = await captureSendBaseline(page);
  await assert.rejects(submitComposedPrompt(page, PROMPT, baseline, FAST), /double-send/);
  assert.equal(state.enterPresses, 0);
});

test("Enter without ack fails closed after exactly one Enter", async () => {
  const { page, state } = submitFake({ click: "throw", enterSends: false });
  const baseline = await captureSendBaseline(page);
  await assert.rejects(submitComposedPrompt(page, PROMPT, baseline, FAST), /not observed/);
  assert.equal(state.enterPresses, 1);
});

test("new user turn text mismatch fails closed", async () => {
  const { page, state } = submitFake({ clickSends: true, sentTurnText: "something else entirely" });
  const baseline = await captureSendBaseline(page);
  await assert.rejects(submitComposedPrompt(page, PROMPT, baseline, FAST), /does not match/);
  assert.equal(state.enterPresses, 0);
});

test("target url drift fails closed without Enter", async () => {
  const { page, state } = submitFake({ driftAfterCalls: 1 });
  const baseline = await captureSendBaseline(page);
  await assert.rejects(submitComposedPrompt(page, PROMPT, baseline, FAST), /different conversation|changed during submit/);
  assert.equal(state.enterPresses, 0);
});

test("empty fresh turns never complete and yield no response", () => {
  const decision = decidePollCompletion({ contentLength: 0, stableCount: 0 }, { turnCount: 2, freshAssistantTexts: [], lastFreshHasCopy: false, thinking: false });
  assert.equal(decision.complete, false);
  assert.equal(decision.response, null);
});

test("only the exact new assistant turn is returned once stable with copy", () => {
  const obs = { turnCount: 4, freshAssistantTexts: ["DIAG3-OK"], lastFreshHasCopy: true, thinking: false };
  const first = decidePollCompletion({ contentLength: 0, stableCount: 0 }, obs);
  assert.equal(first.complete, false);
  const second = decidePollCompletion({ contentLength: first.contentLength, stableCount: first.stableCount }, obs);
  assert.equal(second.complete, true);
  assert.equal(second.response, "DIAG3-OK");
});

test("chrome phrases are stripped from the returned response", () => {
  assert.equal(cleanResponseText("ChatGPT said: hello"), "hello");
  const obs = { turnCount: 3, freshAssistantTexts: ["ChatGPT said: DIAG3-OK"], lastFreshHasCopy: true, thinking: false };
  const first = decidePollCompletion({ contentLength: 0, stableCount: 0 }, obs);
  const second = decidePollCompletion({ contentLength: first.contentLength, stableCount: first.stableCount }, obs);
  assert.equal(second.response, "DIAG3-OK");
});

function domTurn(testid, role, text, copy) {
  const self = {
    innerText: text,
    getAttribute: (name) => (name === "data-testid" ? testid : name === "data-message-author-role" ? role : null),
    querySelector: (sel) => (sel.indexOf("copy-turn-action-button") >= 0 ? (copy ? {} : null) : null),
    closest: () => self,
  };
  return self;
}

test("fresh observer slices strictly after the acked user turn", async () => {
  const { observeFreshTurns: observe } = await import("../dist/chatgpt.js");
  const turns = [
    domTurn("conversation-turn-1", "user", "old question", false),
    domTurn("conversation-turn-2", "assistant", "old answer", true),
    domTurn("conversation-turn-3", "user", PROMPT, false),
    domTurn("conversation-turn-4", "assistant", "DIAG3-OK", true),
  ];
  const previous = globalThis.document;
  globalThis.document = { querySelectorAll: (sel) => (sel.indexOf("assistant") >= 0 ? [] : turns) };
  try {
    const page = { evaluate: async (fn, arg) => fn(arg) };
    const snapshot = await observe(page, 2);
    assert.equal(snapshot.turnCount, 4);
    assert.deepEqual(snapshot.freshAssistantTexts, ["DIAG3-OK"]);
    assert.equal(snapshot.lastFreshHasCopy, true);
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});

test("stale pre-anchor assistant copy never leaks into fresh texts", async () => {
  const { observeFreshTurns: observe } = await import("../dist/chatgpt.js");
  const turns = [
    domTurn("conversation-turn-1", "user", "old question", false),
    domTurn("conversation-turn-2", "assistant", "old answer", true),
  ];
  const previous = globalThis.document;
  globalThis.document = { querySelectorAll: (sel) => (sel.indexOf("assistant") >= 0 ? [] : turns) };
  try {
    const page = { evaluate: async (fn, arg) => fn(arg) };
    const snapshot = await observe(page, 99);
    assert.deepEqual(snapshot.freshAssistantTexts, []);
    assert.equal(snapshot.lastFreshHasCopy, false);
    const decision = decidePollCompletion({ contentLength: 0, stableCount: 0 }, snapshot);
    assert.equal(decision.complete, false);
    assert.equal(decision.response, null);
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});
