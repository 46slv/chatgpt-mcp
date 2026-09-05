import assert from "node:assert/strict";
import test from "node:test";
import { typeText } from "../dist/browser.js";

function typingElement({ click = "ok" } = {}) {
  const calls = { clicks: 0, focuses: 0, fills: [], typed: "" };
  return {
    calls,
    element: {
      click: async () => {
        calls.clicks += 1;
        if (click === "throw") throw new Error("intercepts pointer events");
      },
      focus: async () => { calls.focuses += 1; },
      fill: async (value) => { calls.fills.push(value); },
      type: async (char) => { calls.typed += char; },
    },
  };
}

test("typing clicks then types every character without focus", async () => {
  const fake = typingElement({ click: "ok" });
  assert.equal(await typeText(["#prompt-textarea"], "hi", async () => fake.element), true);
  assert.equal(fake.calls.clicks, 1);
  assert.equal(fake.calls.focuses, 0);
  assert.deepEqual(fake.calls.fills, [""]);
  assert.equal(fake.calls.typed, "hi");
});

test("intercepted click falls back to focus then types", async () => {
  const fake = typingElement({ click: "throw" });
  assert.equal(await typeText(["#prompt-textarea"], "hi", async () => fake.element), true);
  assert.equal(fake.calls.clicks, 1);
  assert.equal(fake.calls.focuses, 1);
  assert.deepEqual(fake.calls.fills, [""]);
  assert.equal(fake.calls.typed, "hi");
});

test("missing element resolves false without input", async () => {
  assert.equal(await typeText(["#prompt-textarea"], "hi", async () => null), false);
});
