import assert from "node:assert/strict";
import test from "node:test";

import { ensureReplyTargetOnPage } from "../dist/chatgpt.js";
import { parseChatGPTTargetUrl } from "../dist/types.js";

function fakePage(initialUrl) {
  let current = initialUrl;
  const navigations = [];
  return {
    page: {
      url: () => current,
      waitForLoadState: async () => {},
    },
    navigations,
    setUrl: (value) => { current = value; },
  };
}

test("targeted reply keeps an already-canonical conversation without navigation", async () => {
  const fake = fakePage("https://chatgpt.com/c/prepared-1");
  let navigationCalls = 0;
  await ensureReplyTargetOnPage(
    fake.page,
    parseChatGPTTargetUrl("https://chatgpt.com/c/prepared-1"),
    {
      navigate: async () => { navigationCalls += 1; return true; },
      isLoggedIn: async () => true,
    },
  );
  assert.equal(navigationCalls, 0);
});

test("targeted reply performs one exact navigation before send", async () => {
  const fake = fakePage("https://chatgpt.com");
  let navigationCalls = 0;
  await ensureReplyTargetOnPage(
    fake.page,
    parseChatGPTTargetUrl("https://chatgpt.com/c/prepared-2"),
    {
      navigate: async (url) => { navigationCalls += 1; fake.setUrl(url); return true; },
      isLoggedIn: async () => true,
    },
  );
  assert.equal(navigationCalls, 1);
  assert.equal(fake.page.url(), "https://chatgpt.com/c/prepared-2");
});

test("targeted reply preserves a project-scoped conversation URL", async () => {
  const targetUrl = "https://chatgpt.com/g/g-p-slug/c/prepared-project-2";
  const fake = fakePage("https://chatgpt.com");
  let navigationTarget = null;
  await ensureReplyTargetOnPage(
    fake.page,
    parseChatGPTTargetUrl(targetUrl),
    {
      navigate: async (url) => { navigationTarget = url; fake.setUrl(url); return true; },
      isLoggedIn: async () => true,
    },
  );
  assert.equal(navigationTarget, targetUrl);
  assert.equal(fake.page.url(), targetUrl);
});

test("redirects, login state, and identity mismatches fail before typing", async () => {
  const target = parseChatGPTTargetUrl("https://chatgpt.com/c/prepared-3");
  const redirected = fakePage("https://chatgpt.com");
  await assert.rejects(
    () => ensureReplyTargetOnPage(redirected.page, target, {
      navigate: async (url) => { redirected.setUrl("https://chatgpt.com/auth/login"); return true; },
      isLoggedIn: async () => true,
    }),
    /redirected/,
  );

  const notLoggedIn = fakePage(target.url);
  await assert.rejects(
    () => ensureReplyTargetOnPage(notLoggedIn.page, target, {
      navigate: async () => true,
      isLoggedIn: async () => false,
    }),
    /not logged in/,
  );

  const wrongConversation = fakePage("https://chatgpt.com/c/other-4");
  await assert.rejects(
    () => ensureReplyTargetOnPage(wrongConversation.page, target, {
      navigate: async () => true,
      isLoggedIn: async () => true,
    }),
    /identity mismatch|redirected/,
  );
});
