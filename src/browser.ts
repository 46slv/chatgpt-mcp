// Browser management for chatgpt-mcp

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { CONFIG } from './types.js';
import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';

let context: BrowserContext | null = null;
let page: Page | null = null;
// A CDP-connected browser is owned by the caller (normally a visible Chrome
// process).  Keep this separate from the persistent context so shutdown can
// disconnect without closing the user's browser or touching its profile.
let attachedBrowser: Browser | null = null;

const CHATGPT_ORIGIN = 'https://chatgpt.com';

/**
 * Validate the optional browser CDP endpoint.  Only loopback HTTP endpoints
 * are accepted; accepting a remote endpoint here would allow credentials and
 * prompts to be sent to an arbitrary browser.
 */
export function resolveCdpUrl(value: unknown = process.env.CHATGPT_MCP_CDP_URL): string | null {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  if (typeof value !== 'string' || value !== value.trim()) {
    throw new Error('CHATGPT_MCP_CDP_URL must be an exact loopback http URL.');
  }
  const match = /^http:\/\/(127\.0\.0\.1|localhost):([0-9]{1,5})$/.exec(value);
  if (!match) {
    throw new Error('CHATGPT_MCP_CDP_URL must match http://127.0.0.1:<port> or http://localhost:<port>.');
  }
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('CHATGPT_MCP_CDP_URL port must be between 1 and 65535.');
  }
  return value;
}

/** Select the transport without creating a browser or touching the profile. */
export function resolveBrowserMode(value: unknown = process.env.CHATGPT_MCP_CDP_URL): 'attach' | 'persistent' {
  return resolveCdpUrl(value) ? 'attach' : 'persistent';
}

function isChatGPTPage(value: Page): boolean {
  try {
    return new URL(value.url()).origin === CHATGPT_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * Pick a page from an attached browser without ever falling back to extension
 * pages, DevTools, chrome:// pages, or other browser UI.  An exact target URL
 * wins; otherwise a focused ChatGPT page wins, then the first ChatGPT page in
 * deterministic browser/context/page order.
 */
export async function selectAttachedPage(
  browser: Pick<Browser, 'contexts'>,
  targetUrl?: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const candidates: Array<{ context: BrowserContext; page: Page }> = [];
  for (const candidateContext of browser.contexts()) {
    for (const candidatePage of candidateContext.pages()) {
      if (!candidatePage.isClosed() && isChatGPTPage(candidatePage)) {
        candidates.push({ context: candidateContext, page: candidatePage });
      }
    }
  }

  if (targetUrl) {
    const exact = candidates.find((candidate) => candidate.page.url() === targetUrl);
    if (exact) return { context: exact.context, page: exact.page };
  }

  for (const candidate of candidates) {
    try {
      if (await candidate.page.evaluate(() => document.hasFocus())) {
        return { context: candidate.context, page: candidate.page };
      }
    } catch {
      // A page can disappear between enumeration and evaluation; continue.
    }
  }

  const first = candidates[0];
  if (first) return { context: first.context, page: first.page };
  throw new Error('No open ChatGPT page found in the attached browser. Open the prepared ChatGPT conversation and retry.');
}

async function ensureUserDataDir(): Promise<void> {
  if (!existsSync(CONFIG.userDataDir)) {
    await mkdir(CONFIG.userDataDir, { recursive: true });
  }
}

/**
 * Launch browser with a persistent user data directory.
 *
 * Uses launchPersistentContext() which maintains the full browser profile
 * on disk (cookies, localStorage, IndexedDB, browser fingerprint).
 * This means:
 * - Login persists across MCP server restarts
 * - Cloudflare bot detection is less likely (consistent fingerprint)
 * - No separate storageState save/load needed
 */
export async function launchBrowser(targetUrl?: string): Promise<Page> {
  const cdpUrl = resolveCdpUrl();

  if (attachedBrowser) {
    const selected = await selectAttachedPage(attachedBrowser, targetUrl);
    context = selected.context;
    page = selected.page;
    return page;
  }

  if (page && !page.isClosed()) {
    return page;
  }

  if (cdpUrl) {
    attachedBrowser = await chromium.connectOverCDP(cdpUrl);
    const selected = await selectAttachedPage(attachedBrowser, targetUrl);
    context = selected.context;
    page = selected.page;
    return page;
  }

  await ensureUserDataDir();

  context = await chromium.launchPersistentContext(CONFIG.userDataDir, {
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ],
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });

  // Use the first page if one already exists, otherwise create one
  const pages = context.pages();
  page = pages.length > 0 ? pages[0] : await context.newPage();

  return page;
}

/**
 * Save browser storage state — with persistent context this is mostly a no-op
 * since the profile is on disk, but we call it for extra safety.
 */
export async function saveStorageState(): Promise<void> {
  // Persistent context auto-saves to userDataDir, nothing to do
}

/**
 * Get the current page, launching browser if needed
 */
export async function getPage(targetUrl?: string): Promise<Page> {
  if (attachedBrowser) {
    // Once a target has been selected, keep using that page for all DOM
    // operations in this request.  Re-running focused-page discovery for every
    // selector could silently switch to another open conversation mid-send.
    if (!targetUrl && page && !page.isClosed() && isChatGPTPage(page)) return page;
    const selected = await selectAttachedPage(attachedBrowser, targetUrl);
    context = selected.context;
    page = selected.page;
    return page;
  }
  if (!page || page.isClosed()) {
    return launchBrowser(targetUrl);
  }
  return page;
}

/**
 * Check if browser is running
 */
export function isBrowserRunning(): boolean {
  return page !== null && !page.isClosed();
}

/** Whether this process is connected to a caller-owned browser via CDP. */
export function isBrowserAttached(): boolean {
  return attachedBrowser !== null;
}

/** Disconnect a caller-owned CDP connection without closing its browser. */
export function disconnectAttachedBrowser(browser: Browser): void {
  const transport = browser as Browser & { _connection?: { close: () => void } };
  if (!transport._connection || typeof transport._connection.close !== 'function') {
    throw new Error('Attached browser transport does not expose a disconnectable CDP connection.');
  }
  transport._connection.close();
}

/**
 * Close the browser
 */
export async function closeBrowser(): Promise<void> {
  if (attachedBrowser) {
    // Browser.close() would terminate the external Chrome process.  A CDP
    // transport is caller-owned, so disconnect only and leave all pages,
    // contexts, cookies, and profile state intact.
    // Playwright exposes `disconnect()` only for a few older transport
    // variants.  connectOverCDP keeps the connection private, so close that
    // local connection directly rather than calling Browser.close(), which
    // would ask the remote browser to terminate its target.
    disconnectAttachedBrowser(attachedBrowser);
    attachedBrowser = null;
  } else if (context) {
    await context.close();
  }

  page = null;
  context = null;
}

/**
 * Navigate to a URL with error handling
 */
export async function navigateTo(url: string): Promise<boolean> {
  const p = await getPage();
  try {
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.defaultTimeout });
    return true;
  } catch (error) {
    console.error(`Failed to navigate to ${url}:`, error);
    return false;
  }
}

/**
 * Find an element using multiple selector fallbacks
 */
export async function findElement(selectors: readonly string[], timeout = 5000): Promise<any | null> {
  const p = await getPage();

  for (const selector of selectors) {
    try {
      const element = await p.waitForSelector(selector, { timeout, state: 'visible' });
      if (element) {
        return element;
      }
    } catch {
      // Try next selector
    }
  }

  return null;
}

/**
 * Check if any selector matches an element on the page
 */
export async function elementExists(selectors: readonly string[]): Promise<boolean> {
  const p = await getPage();

  for (const selector of selectors) {
    try {
      const element = await p.$(selector);
      if (element) {
        return true;
      }
    } catch {
      // Try next selector
    }
  }

  return false;
}

/**
 * Type text into an element found by selectors
 */
export async function typeText(selectors: readonly string[], text: string): Promise<boolean> {
  const element = await findElement(selectors);
  if (!element) {
    return false;
  }

  await element.click();
  await element.fill('');

  for (const char of text) {
    await element.type(char, { delay: CONFIG.typingDelay });
  }

  return true;
}

/**
 * Click an element found by selectors
 */
export async function clickElement(selectors: readonly string[]): Promise<boolean> {
  const element = await findElement(selectors);
  if (!element) {
    return false;
  }

  await element.click();
  return true;
}

/**
 * Get text content from an element
 */
export async function getElementText(selectors: readonly string[]): Promise<string | null> {
  const element = await findElement(selectors, 10000);
  if (!element) {
    return null;
  }

  return element.innerText();
}

/**
 * Wait for a specified duration
 */
export async function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute JavaScript on the page
 */
export async function evaluate<T>(fn: () => T): Promise<T> {
  const p = await getPage();
  return p.evaluate(fn);
}
