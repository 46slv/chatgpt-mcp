import assert from "node:assert/strict";
import test from "node:test";

import {
  checkLoginStatusOnPage,
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
