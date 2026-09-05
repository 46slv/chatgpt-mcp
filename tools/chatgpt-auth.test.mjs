import assert from "node:assert/strict";
import test from "node:test";

import {
  checkLoginStatusOnPage,
  checkLoginStatusWithRetries,
  loginReadinessFromSnapshot,
} from "../dist/chatgpt.js";

const TARGET = "https://chatgpt.com/c/prepared-auth";
const target = { url: TARGET, conversationId: "prepared-auth" };

function fakePage(url, snapshot) {
  return {
    url: () => url,
    evaluate: async () => snapshot,
  };
}

test("authenticated modern UI is ready without a profile/avatar indicator", async () => {
  assert.equal(await checkLoginStatusOnPage(fakePage(TARGET, {
    composerVisible: true,
    composerEnabled: true,
    authChallengeVisible: false,
  }), target), true);
});

test("login page is not ready even when a stale composer is present", async () => {
  assert.equal(await checkLoginStatusOnPage(fakePage(TARGET, {
    composerVisible: true,
    composerEnabled: true,
    authChallengeVisible: true,
  }), target), false);
});

test("signup challenge is not ready", async () => {
  assert.equal(loginReadinessFromSnapshot({
    composerVisible: true,
    composerEnabled: true,
    authChallengeVisible: true,
    actualUrl: TARGET,
  }, TARGET), false);
});

test("loading/no-composer state is fail-closed", async () => {
  assert.equal(loginReadinessFromSnapshot({
    composerVisible: false,
    composerEnabled: false,
    authChallengeVisible: false,
    actualUrl: TARGET,
  }, TARGET), false);
});

test("hidden composer is not positive authentication evidence", async () => {
  assert.equal(loginReadinessFromSnapshot({
    composerVisible: false,
    composerEnabled: true,
    authChallengeVisible: false,
    actualUrl: TARGET,
  }, TARGET), false);
});

test("targeted readiness requires the exact conversation URL", async () => {
  assert.equal(await checkLoginStatusOnPage(fakePage("https://chatgpt.com/c/other", {
    composerVisible: true,
    composerEnabled: true,
    authChallengeVisible: false,
  }), target), false);
  assert.equal(await checkLoginStatusOnPage(fakePage(TARGET, {
    composerVisible: true,
    composerEnabled: true,
    authChallengeVisible: false,
  }), target), true);
});

test("targeted login retries preserve the exact target identity", async () => {
  const seen = [];
  let attempts = 0;
  const result = await checkLoginStatusWithRetries(target, async (received) => {
    seen.push(received);
    attempts += 1;
    return attempts === 2;
  }, async () => {});
  assert.equal(result, true);
  assert.equal(attempts, 2);
  assert.deepEqual(seen, [target, target]);
});

test("legacy login retries retain the no-target call contract", async () => {
  const seen = [];
  let attempts = 0;
  const result = await checkLoginStatusWithRetries(undefined, async (received) => {
    seen.push(received);
    attempts += 1;
    return attempts === 2;
  }, async () => {});
  assert.equal(result, true);
  assert.deepEqual(seen, [undefined, undefined]);
});

class FakeDomElement {
  constructor(options = {}) {
    this.attrs = options.attrs ?? {};
    this.style = options.style ?? { display: "block", visibility: "visible", opacity: "1" };
    this.rect = options.rect ?? { width: 100, height: 40 };
    this.textContent = options.text ?? "";
  }
  getAttribute(name) { return this.attrs[name] ?? null; }
  matches(selector) {
    if (selector === '[contenteditable="false"]') return this.attrs.contenteditable === "false";
    if (selector === '[contenteditable="true"]') return this.attrs.contenteditable === "true";
    return false;
  }
  getBoundingClientRect() { return this.rect; }
}

function installFakeDom() {
  const previous = { html: globalThis.HTMLElement, window: globalThis.window, document: globalThis.document };
  globalThis.HTMLElement = FakeDomElement;
  globalThis.window = { getComputedStyle: (element) => element.style };
  return previous;
}

function restoreFakeDom(previous) {
  if (previous.html === undefined) delete globalThis.HTMLElement;
  else globalThis.HTMLElement = previous.html;
  if (previous.window === undefined) delete globalThis.window;
  else globalThis.window = previous.window;
  if (previous.document === undefined) delete globalThis.document;
  else globalThis.document = previous.document;
}

function domGatePage({ composer = [], auth = [], url = TARGET } = {}) {
  return {
    url: () => url,
    evaluate: async (fn, arg) => {
      const previous = installFakeDom();
      globalThis.document = {
        querySelectorAll: (selector) => (selector.indexOf("button, a, input") === 0 ? auth : composer),
      };
      try {
        return await fn(arg);
      } finally {
        restoreFakeDom(previous);
      }
    },
  };
}

function operableComposer() {
  return new FakeDomElement({
    attrs: { id: "prompt-textarea", "aria-hidden": "true", "aria-label": "ChatGPT", contenteditable: "true" },
    style: { display: "block", visibility: "visible", opacity: "1" },
    rect: { width: 462, height: 47 },
    text: "",
  });
}

test("aria-hidden operable composer counts as login readiness", async () => {
  assert.equal(await checkLoginStatusOnPage(domGatePage({ composer: [operableComposer()] }), target), true);
});

test("display-none composer stays fail-closed", async () => {
  const hidden = new FakeDomElement({
    attrs: { id: "prompt-textarea", contenteditable: "true" },
    style: { display: "none", visibility: "visible", opacity: "1" },
    rect: { width: 0, height: 0 },
    text: "",
  });
  assert.equal(await checkLoginStatusOnPage(domGatePage({ composer: [hidden] }), target), false);
});

test("visible login challenge still fails readiness with operable composer", async () => {
  const loginButton = new FakeDomElement({
    attrs: { "aria-label": "Log in" },
    style: { display: "block", visibility: "visible", opacity: "1" },
    rect: { width: 80, height: 32 },
    text: "Log in",
  });
  assert.equal(await checkLoginStatusOnPage(domGatePage({ composer: [operableComposer()], auth: [loginButton] }), target), false);
});
