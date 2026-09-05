import assert from "node:assert/strict";
import test from "node:test";
import { typeText } from "../dist/browser.js";

function typingElement({ click = "ok" } = {}) {
  const calls = { clicks: 0, focuses: 0, fills: [], types: 0 };
  return {
    calls,
    element: {
      click: async () => {
        calls.clicks += 1;
        if (click === "throw") throw new Error("intercepts pointer events");
      },
      focus: async () => { calls.focuses += 1; },
      fill: async (value) => { calls.fills.push(value); },
      type: async () => { calls.types += 1; },
    },
  };
}

test("typing clicks then fills the whole prompt without focus or key stream", async () => {
  const fake = typingElement({ click: "ok" });
  assert.equal(await typeText(["#prompt-textarea"], "hi", async () => fake.element), true);
  assert.equal(fake.calls.clicks, 1);
  assert.equal(fake.calls.focuses, 0);
  assert.deepEqual(fake.calls.fills, ["", "hi"]);
  assert.equal(fake.calls.types, 0);
});

test("intercepted click falls back to focus then fills the whole prompt", async () => {
  const fake = typingElement({ click: "throw" });
  assert.equal(await typeText(["#prompt-textarea"], "hi", async () => fake.element), true);
  assert.equal(fake.calls.clicks, 1);
  assert.equal(fake.calls.focuses, 1);
  assert.deepEqual(fake.calls.fills, ["", "hi"]);
  assert.equal(fake.calls.types, 0);
});

test("long multi-line prompt is set with one atomic fill", async () => {
  const fake = typingElement({ click: "throw" });
  const payload = Array.from({ length: 60 }, (_, i) => "Line " + String(i).padStart(2, "0") + " abcdefghij0123456789").join("\n");
  assert.ok(payload.length > 1600);
  assert.equal(await typeText(["#prompt-textarea"], payload, async () => fake.element), true);
  assert.deepEqual(fake.calls.fills, ["", payload]);
  assert.equal(fake.calls.types, 0);
});

test("missing element resolves false without input", async () => {
  assert.equal(await typeText(["#prompt-textarea"], "hi", async () => null), false);
});

