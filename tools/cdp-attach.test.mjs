import assert from 'node:assert/strict';
import test from 'node:test';

import {
  disconnectAttachedBrowser,
  resolveBrowserMode,
  resolveCdpUrl,
  selectAttachedPage,
} from '../dist/browser.js';

function fakePage(url, focused = false) {
  return {
    url: () => url,
    isClosed: () => false,
    evaluate: async () => focused,
  };
}

function fakeContext(pages) {
  return { pages: () => pages };
}

test('CDP endpoint accepts only bounded loopback URLs and takes attach precedence', () => {
  assert.equal(resolveCdpUrl('http://127.0.0.1:9222'), 'http://127.0.0.1:9222');
  assert.equal(resolveCdpUrl('http://localhost:65535'), 'http://localhost:65535');
  assert.equal(resolveBrowserMode('http://127.0.0.1:9222'), 'attach');
  assert.equal(resolveBrowserMode(''), 'persistent');
  assert.equal(resolveCdpUrl(undefined), null);
  for (const value of [
    'https://127.0.0.1:9222',
    'http://0.0.0.0:9222',
    'http://127.0.0.1:0',
    'http://127.0.0.1:65536',
    'http://127.0.0.1:9222/',
    'http://127.0.0.1:9222?x=1',
  ]) {
    assert.throws(() => resolveCdpUrl(value), /CHATGPT_MCP_CDP_URL/);
  }
});

test('attached page selection prefers exact target, then focus, then first same-origin page', async () => {
  const extension = fakePage('chrome-extension://abc/options.html', true);
  const firstChat = fakePage('https://chatgpt.com/c/first');
  const focusedChat = fakePage('https://chatgpt.com/c/focused', true);
  const exactChat = fakePage('https://chatgpt.com/c/exact');
  const context = fakeContext([extension, firstChat, focusedChat, exactChat]);
  const browser = { contexts: () => [context] };

  const exact = await selectAttachedPage(browser, exactChat.url());
  assert.equal(exact.page, exactChat);
  const focused = await selectAttachedPage(browser);
  assert.equal(focused.page, focusedChat);

  const firstOnly = await selectAttachedPage({ contexts: () => [fakeContext([extension, firstChat])] });
  assert.equal(firstOnly.page, firstChat);
});

test('attached selection fails closed when no ChatGPT page is open', async () => {
  await assert.rejects(
    () => selectAttachedPage({ contexts: () => [fakeContext([fakePage('chrome://settings')])] }),
    /No open ChatGPT page/,
  );
});

test('CDP cleanup disconnects transport and never calls browser close', () => {
  let disconnected = 0;
  let closed = 0;
  const browser = {
    _connection: { close: () => { disconnected += 1; } },
    close: () => { closed += 1; },
  };
  disconnectAttachedBrowser(browser);
  assert.equal(disconnected, 1);
  assert.equal(closed, 0);
});

