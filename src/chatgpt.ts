// ChatGPT interaction logic — merges gpt-bridge + chatgpt-desktop-mcp

import {
  SessionState,
  AskResult,
  SimpleResult,
  SELECTORS,
  CONFIG,
  ChatGPTTargetIdentity,
  parseChatGPTTargetUrl,
  validateConversationId,
} from './types.js';
import {
  getPage,
  navigateTo,
  findElement,
  typeText,
  wait,
  saveStorageState,
  isBrowserRunning,
  isBrowserAttached,
  launchBrowser,
} from './browser.js';
import { fibonacciBackoff, sleep } from './utils/backoff.js';
import { appendStageEvent } from './utils/stage-sidecar.js';

// ============================================
// Global state
// ============================================

let sessionState: SessionState = {
  isLoggedIn: false,
  currentModel: null,
  conversationId: null,
  currentProjectUrl: null,
};

let sessionInitialized = false;

export interface BlockingReplyOptions {
  /** Exact prepared conversation URL. Omit for legacy current-chat behavior. */
  target_url?: string;
  /** Expected conversation id; when omitted it is derived from target_url. */
  expected_conversation_id?: string;
}

/**
 * Validate and normalize the runner-owned target contract before any browser
 * interaction.  A supplied expected id is intentionally required to agree
 * with the URL so callers cannot freeze one identity and send to another.
 */
function resolveReplyTarget(options: BlockingReplyOptions = {}): ChatGPTTargetIdentity | null {
  const hasUrl = options.target_url !== undefined && options.target_url !== null;
  const hasConversationId = options.expected_conversation_id !== undefined && options.expected_conversation_id !== null;

  if (!hasUrl && !hasConversationId) return null;
  if (!hasUrl) throw new Error('expected_conversation_id requires target_url.');

  const parsed = parseChatGPTTargetUrl(options.target_url);
  if (hasConversationId) {
    const expected = validateConversationId(options.expected_conversation_id);
    if (expected !== parsed.conversationId) {
      throw new Error('Target URL and expected conversation id do not match.');
    }
  }
  return parsed;
}

/**
 * Ensure the persistent, logged-in browser is at the exact prepared target.
 * Navigation is skipped when the current URL is already canonical, avoiding
 * needless reloads in a long-running consultation loop.  Any login/home or
 * redirect/mismatch is rejected before the prompt textarea is touched.
 */
export async function ensureReplyTargetOnPage(
  page: { url(): string; waitForLoadState?: (state: 'domcontentloaded', options?: { timeout?: number }) => Promise<unknown> },
  target: ChatGPTTargetIdentity,
  dependencies: {
    navigate: (url: string) => Promise<boolean>;
    isLoggedIn: () => Promise<boolean>;
  },
): Promise<void> {
  await navigateAndVerifyReplyTargetOnPage(page, target, dependencies.navigate);

  if (!(await dependencies.isLoggedIn())) {
    throw new Error('ChatGPT session is not logged in at the targeted conversation.');
  }
}

/**
 * Move an attached/persistent page to a runner-owned target and verify the
 * complete canonical URL before any authentication or composer checks.
 *
 * Keeping this navigation-only phase separate is important for startup: a
 * target supplied on the first call must not be sent through the legacy home
 * navigation or login check while the browser is still on another tab.
 */
export async function navigateAndVerifyReplyTargetOnPage(
  page: { url(): string; waitForLoadState?: (state: 'domcontentloaded', options?: { timeout?: number }) => Promise<unknown> },
  target: ChatGPTTargetIdentity,
  navigate: (url: string) => Promise<boolean>,
): Promise<void> {
  const currentUrl = page.url();
  if (currentUrl !== target.url) {
    const navigated = await navigate(target.url);
    if (!navigated) throw new Error('Failed to navigate to targeted ChatGPT conversation.');
    if (page.waitForLoadState) {
      await page.waitForLoadState('domcontentloaded', { timeout: CONFIG.defaultTimeout });
    }
    await wait(500);
  }

  const finalUrl = page.url();
  let finalTarget: ChatGPTTargetIdentity;
  try {
    finalTarget = parseChatGPTTargetUrl(finalUrl);
  } catch {
    throw new Error('Target navigation redirected away from the requested ChatGPT conversation.');
  }
  if (finalTarget.url !== target.url || finalTarget.conversationId !== target.conversationId) {
    throw new Error('Target conversation identity mismatch after navigation.');
  }
}

async function ensureReplyTarget(target: ChatGPTTargetIdentity): Promise<void> {
  // In CDP attach mode this re-selects the exact prepared tab before any
  // navigation.  If it is not open, selection falls back only to a focused
  // same-origin ChatGPT page; extension/browser UI pages are never eligible.
  const page = await getPage(target.url);
  await ensureReplyTargetOnPage(page, target, {
    navigate: navigateTo,
    isLoggedIn: () => checkLoginStatus(target),
  });
}

// ============================================
// Session management
// ============================================

/**
 * Auto-start session on first call. Not exposed as a tool.
 */
export async function ensureSession(target?: ChatGPTTargetIdentity): Promise<void> {
  if (sessionInitialized && isBrowserRunning()) {
    if (target) {
      const currentPage = await getPage(target.url);
      await navigateAndVerifyReplyTargetOnPage(currentPage, target, navigateTo);
    }
    return;
  }

  await launchBrowser(target?.url);
  const currentPage = await getPage(target?.url);

  // A CDP attach session already has a user-controlled ChatGPT tab.  Preserve
  // an exact prepared target and avoid navigating it away to the home page.
  // For an attached non-ChatGPT page, navigate the selected safe page to home
  // so legacy ask flows still have a usable composer.
  if (target) {
    // Targeted startup must navigate to the exact prepared conversation first
    // and only then perform the targeted login/composer readiness check.
    // This also preserves a project-scoped /g/<slug>/c/<id> URL verbatim.
    await navigateAndVerifyReplyTargetOnPage(currentPage, target, navigateTo);
  } else {
    let success = true;
    if (!isBrowserAttached() || !/^https:\/\/chatgpt\.com(?:\/|$)/.test(currentPage.url())) {
      success = await navigateTo(CONFIG.chatgptUrl);
    }
    if (!success) {
      throw new Error('Failed to navigate to ChatGPT');
    }
  }

  // Wait for page to settle, then check login with retries
  // (Cloudflare checks or slow loads can cause false negatives)
  await wait(3000);

  const isLoggedIn = await checkLoginStatusWithRetries(target);

  sessionState.isLoggedIn = isLoggedIn;
  sessionInitialized = true;

  if (!isLoggedIn) {
    throw new Error(
      'Not logged in to ChatGPT. Please log in manually in the browser window, then retry.'
    );
  }

  await saveStorageState();

  // Auto-select default project on first launch
  if (!target && CONFIG.defaultProject && !sessionState.currentProjectUrl) {
    const result = await selectProject(CONFIG.defaultProject);
    if (result.success) {
      console.error(`[session] Auto-selected default project: ${CONFIG.defaultProject}`);
    } else {
      console.error(`[session] Default project "${CONFIG.defaultProject}" not found, using home`);
    }
  }
}

/**
 * The small, serializable observation used by the authentication gate.  Keep
 * this separate from Playwright so the fail-closed decision can be unit
 * tested without a live browser.
 */
export interface LoginReadinessSnapshot {
  composerVisible: boolean;
  composerEnabled: boolean;
  authChallengeVisible: boolean;
  actualUrl?: string;
}

/**
 * Check login readiness while preserving the caller's exact target identity.
 *
 * The optional dependencies keep this small retry policy deterministic in
 * tests; production callers use the browser-backed defaults.  Passing the
 * target on every attempt is important because an untargeted retry can select
 * a different ChatGPT tab and report readiness for the wrong conversation.
 */
export async function checkLoginStatusWithRetries(
  target?: ChatGPTTargetIdentity,
  check: (target?: ChatGPTTargetIdentity) => Promise<boolean> = checkLoginStatus,
  retryWait: () => Promise<void> = () => wait(3000),
): Promise<boolean> {
  let isLoggedIn = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    isLoggedIn = await check(target);
    if (isLoggedIn) break;
    console.error(`[session] Login check attempt ${attempt + 1} failed, retrying...`);
    await retryWait();
  }
  return isLoggedIn;
}

/**
 * Return true only when a page is ready for an authenticated reply.
 *
 * A profile/avatar is not sufficient evidence: it can survive a redirect or
 * be rendered in a stale shell.  Positive evidence is a visible, enabled
 * composer on the exact canonical target, together with no visible login,
 * signup, or authentication challenge.  Missing/partial observations are
 * intentionally treated as false.
 */
export function loginReadinessFromSnapshot(
  snapshot: LoginReadinessSnapshot,
  expectedTargetUrl?: string,
): boolean {
  if (!snapshot || !snapshot.composerVisible || !snapshot.composerEnabled) return false;
  if (snapshot.authChallengeVisible) return false;
  if (expectedTargetUrl && snapshot.actualUrl !== expectedTargetUrl) return false;
  return true;
}

type LoginReadinessPage = {
  url(): string;
  evaluate?: (pageFunction: (input: { composerSelectors: readonly string[] }) => LoginReadinessSnapshot | Promise<LoginReadinessSnapshot>, arg: { composerSelectors: readonly string[] }) => Promise<LoginReadinessSnapshot>;
};

/**
 * Inspect the current page's DOM for authenticated composer readiness.
 * `target` is optional for legacy current-chat calls; targeted callers should
 * always pass it so this gate independently enforces exact URL identity.
 */
export async function checkLoginStatusOnPage(
  page: LoginReadinessPage,
  target?: ChatGPTTargetIdentity,
): Promise<boolean> {
  const expectedTargetUrl = target?.url;
  const actualUrl = page.url();
  if (expectedTargetUrl && actualUrl !== expectedTargetUrl) return false;
  if (typeof page.evaluate !== 'function') return false;

  try {
    const observed = await page.evaluate((input) => {
      const isVisible = (element: Element): boolean => {
        if (!(element instanceof HTMLElement)) return false;
        if (element.getAttribute('aria-hidden') === 'true') return false;
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const isEnabled = (element: Element): boolean => {
        if (!(element instanceof HTMLElement)) return false;
        if (element.getAttribute('aria-disabled') === 'true') return false;
        if ('disabled' in element && Boolean((element as HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement).disabled)) return false;
        if (element.matches('[contenteditable="false"]')) return false;
        return true;
      };

      const composerElements = input.composerSelectors.flatMap((selector) => {
        try {
          return Array.from(document.querySelectorAll(selector));
        } catch {
          return [];
        }
      });
      // The shipped composer editor carries aria-hidden while remaining the
      // operable input: it accepts focus and real key events and has a live
      // layout box. Rejecting it on aria-hidden alone wedges every send
      // behind a failed readiness gate, so an aria-hidden contenteditable
      // composer with a real layout box still counts when it is enabled.
      // Fully hidden elements (display/visibility/opacity/zero rect) never count.
      const isOperableComposer = (element: Element): boolean => {
        if (!(element instanceof HTMLElement)) return false;
        if (!element.matches('[contenteditable="true"]')) return false;
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
        const rect = element.getBoundingClientRect();
        if (!(rect.width > 0 && rect.height > 0)) return false;
        return isEnabled(element);
      };
      const composerVisible = composerElements.some((element) => isVisible(element) || isOperableComposer(element));
      const composerEnabled = composerElements.some((element) => (isVisible(element) || isOperableComposer(element)) && isEnabled(element));

      // Text is restricted to interactive/auth containers so a conversation
      // that merely mentions “log in” cannot masquerade as an auth challenge.
      const authPattern = /\b(?:log\s*in|sign\s*(?:in|up)|create\s+account|continue\s+with\s+(?:google|microsoft|apple)|authentication\s+required)\b/i;
      const authCandidates = document.querySelectorAll(
        'button, a, input, label, form, [role="button"], [role="dialog"], [data-testid*="login"], [data-testid*="signup"], [data-testid*="sign-up"], [id*="login"], [id*="signup"], [id*="sign-up"], [class*="login"], [class*="signup"], [class*="sign-up"], [class*="auth"]',
      );
      const authChallengeVisible = Array.from(authCandidates).some((element) => {
        if (!isVisible(element)) return false;
        const text = [
          element.textContent || '',
          element.getAttribute('aria-label') || '',
          element.getAttribute('placeholder') || '',
          element.getAttribute('data-testid') || '',
          element.id || '',
        ].join(' ');
        return authPattern.test(text);
      });

      return { composerVisible, composerEnabled, authChallengeVisible };
    }, { composerSelectors: SELECTORS.promptTextarea });

    // A redirect or tab switch during DOM evaluation must also fail closed.
    const finalUrl = page.url();
    return loginReadinessFromSnapshot({ ...observed, actualUrl: finalUrl }, expectedTargetUrl) && finalUrl === actualUrl;
  } catch {
    return false;
  }
}

/** Check if the current ChatGPT page is authenticated and ready to type. */
async function checkLoginStatus(target?: ChatGPTTargetIdentity): Promise<boolean> {
  const page = await getPage(target?.url);
  return checkLoginStatusOnPage(page, target);
}

// ============================================
// Response extraction (from gpt-bridge — most valuable code)
// ============================================

/**
 * Get the latest assistant response text from the page.
 *
 * ChatGPT DOM as of 2026-02:
 * - Each message is in [data-testid="conversation-turn-N"]
 * - Turn 1 = user, Turn 2 = assistant, Turn 3 = user, etc.
 * - The response text is the innerText of the last turn, minus UI chrome
 * - .markdown/.prose selectors may or may not exist depending on response type
 *
 * Strategy: get the last conversation turn's innerText via the browser's
 * HTMLElement.innerText (which respects visibility), then clean UI phrases.
 */
/**
 * Fresh-turn observation for the response poll. freshAssistantTexts holds
 * assistant-side texts from turns whose global sequence number is strictly
 * above the anchor, in document order. Sequences at or below the anchor are
 * never consulted, so a stale pre-send assistant message (with its copy
 * button) cannot be mistaken for the current response, even as the
 * virtualized window slides and positions shift.
 */
export interface FreshTurnSnapshot {
  turnCount: number;
  freshAssistantTexts: string[];
  lastFreshHasCopy: boolean;
  thinking: boolean;
}

/** Anchor for the response poll: only turns after this user turn qualify. */
export interface PollAnchor {
  afterUserTurnSeq: number;
}

export interface PollProgress {
  contentLength: number;
  stableCount: number;
}

export interface PollDecision extends PollProgress {
  complete: boolean;
  response: string | null;
}
/** UI chrome phrases that appear in turn elements but are not response text. */
export function cleanResponseText(value: unknown): string {
  let cleaned = String(value ?? '');
  const phrasesToRemove = [
    'ChatGPT said:',
    'ChatGPT said',
    'Pro thinking',
    'Answer now',
    'Extended thinking',
    'Show thinking',
    'Hide thinking',
    'Reasoning',
    'Thinking...',
    'Thinking\u2026',
    '\u2022 ',
  ];
  for (const phrase of phrasesToRemove) {
    while (cleaned.includes(phrase)) {
      cleaned = cleaned.replace(phrase, '');
    }
  }
  cleaned = cleaned.replace(/^Thinking\s*/i, '');
  cleaned = cleaned.replace(/Pro\s+thinking\s*\u2022?\s*/gi, '');
  cleaned = cleaned.replace(/^\d+\s*(seconds?|secs?)\s*/i, '');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return cleaned;
}
/**
 * Read one bounded snapshot of the turns sequenced after the acked user turn.
 * The evaluate closure is self-contained: every selector it needs is
 * inlined because only the anchor travels into the page. Positions are
 * window-relative, so filtering uses the global sequence numbers parsed
 * from the test ids, never positions.
 */
export async function observeFreshTurns(page: { evaluate<R>(fn: (anchor: number) => R, arg: number): Promise<R> }, afterUserTurnSeq: number): Promise<FreshTurnSnapshot> {
  return page.evaluate((anchor: number) => {
    const turns = Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"]'));
    const seqOf = (element: Element): number | null => {
      const match = /conversation-turn-(\d+)\s*$/.exec(element.getAttribute('data-testid') ?? '');
      return match ? Number.parseInt(match[1], 10) : null;
    };
    const fresh = turns.filter((turn) => (seqOf(turn) ?? -1) > anchor);
    const texts: string[] = [];
    const seen = new Set<string>();
    const take = (element: Element | null): void => {
      if (!element) return;
      const text = (element as HTMLElement).innerText?.trim() ?? '';
      if (text.length === 0 || seen.has(text)) return;
      seen.add(text);
      texts.push(text);
    };
    for (const turn of fresh) {
      const role = turn.getAttribute('data-message-author-role');
      if (role !== null && role !== 'assistant') continue;
      take(turn);
    }
    const assistants = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
    for (const message of assistants) {
      const host = message.closest('[data-testid^="conversation-turn-"]');
      if (host !== null && (seqOf(host) ?? -1) <= anchor) continue;
      take(message);
    }
    const last = fresh.length > 0 ? fresh[fresh.length - 1] : null;
    const lastFreshHasCopy = last === null ? false : !!last.querySelector('[data-testid="copy-turn-action-button"]');
    let thinking = false;
    if (last !== null) {
      const turnText = (last as HTMLElement).innerText || '';
      thinking = !!last.querySelector('[class*="thinking"], [class*="reasoning"], [data-testid*="thinking"]')
        || (/\b(thinking|reasoning)\b/i.test(turnText) && turnText.length < 200);
    }
    return { turnCount: turns.length, freshAssistantTexts: texts, lastFreshHasCopy, thinking };
  }, afterUserTurnSeq);
}

/** Pure poll step over one fresh-turn snapshot. Unit-testable without a browser. */
export function decidePollCompletion(prev: PollProgress, obs: FreshTurnSnapshot): PollDecision {
  const raw = obs.freshAssistantTexts.length > 0 ? obs.freshAssistantTexts[obs.freshAssistantTexts.length - 1] : '';
  const cleaned = cleanResponseText(raw);
  const currentLength = cleaned.length;
  let stableCount = prev.stableCount;
  if (currentLength > 0 && currentLength === prev.contentLength) stableCount += 1;
  else stableCount = 0;
  const FALLBACK_STABLE_THRESHOLD = 10;
  const complete = (obs.lastFreshHasCopy && currentLength > 0 && stableCount >= 1)
    || (!obs.thinking && currentLength > 0 && stableCount >= FALLBACK_STABLE_THRESHOLD);
  return { complete, contentLength: currentLength, stableCount, response: complete ? cleaned : null };
}

// ============================================
// Prompt sending
// ============================================

/**
 * Minimal structural surface used to submit and observe the composer.
 * Playwright pages satisfy it; tests inject fakes.
 */
export interface ComposerSubmitPage {
  url(): string;
  locator(selector: string): {
    first(): { focus(): Promise<void>; innerText(): Promise<string>; click(options?: unknown): Promise<void> };
    nth(index: number): {
      click(options?: unknown): Promise<void>;
      isVisible(): Promise<boolean>;
      innerText(): Promise<string>;
      getAttribute(name: string): Promise<string | null>;
    };
    count(): Promise<number>;
  };
  keyboard: { press(key: string): Promise<void> };
}

/**
 * Pre-send observation. Nothing here proves a send happened.
 *
 * The turn list is a virtualized window: nodes slide out and global
 * conversation-turn-N sequence numbers (not window positions) are the
 * stable identity. maxSeq anchors the send and the poll on those numbers.
 */
export interface SendBaseline {
  url: string;
  turnCount: number;
  lastTurnTestId: string | null;
  maxSeq: number;
}

/**
 * Delivery acknowledgment. The new user turn carries the global sequence
 * userTurnSeq (window positions shift as the virtualized list slides, so
 * userTurnIndex is diagnostic only); every assistant turn answering this
 * send carries a strictly higher sequence number.
 */
export interface SendAcknowledgment {
  url: string;
  userTurnIndex: number;
  userTurnSeq: number;
  ackTurnCount: number;
  userTurnText: string | null;
}

/**
 * Render chrome appended to posted long turns: collapsed-message expander
 * labels (Japanese show-more/show-less plus English Show more/Show less).
 * The posted node holds the full prompt text plus the label (observed live
 * twice as an identical 1639-char rendering with a trailing expander label),
 * so the label is stripped from OBSERVED turn text only, before the ack
 * comparison. The expected prompt is never stripped: any other difference
 * still fails closed.
 */
const POSTED_TURN_CHROME = ['\u8868\u793a\u3092\u5897\u3084\u3059', '\u8868\u793a\u3092\u6e1b\u3089\u3059', 'Show more', 'Show less'];
export function stripPostedChrome(value: unknown): string {
  let out = String(value ?? '');
  for (const phrase of POSTED_TURN_CHROME) {
    while (out.includes(phrase)) {
      out = out.replace(phrase, '');
    }
  }
  return out;
}

const COMPOSER_TURN_SELECTOR = '[data-testid^="conversation-turn-"]';

export function normalizeComposedText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** Global sequence number parsed from a conversation-turn-N test id. */
export function turnSeqFromTestId(value: unknown): number | null {
  const match = /conversation-turn-(\d+)\s*$/.exec(String(value ?? ''));
  return match ? Number.parseInt(match[1], 10) : null;
}

/** Window positions plus stable global sequences, in document order. */
async function readTurnSeqs(page: ComposerSubmitPage): Promise<Array<{ seq: number; index: number }>> {
  const total = await page.locator(COMPOSER_TURN_SELECTOR).count();
  const entries: Array<{ seq: number; index: number }> = [];
  for (let index = 0; index < total; index++) {
    let testid: string | null = null;
    try {
      testid = await page.locator(COMPOSER_TURN_SELECTOR).nth(index).getAttribute('data-testid');
    } catch {
      testid = null;
    }
    const seq = turnSeqFromTestId(testid);
    if (seq !== null) entries.push({ seq, index });
  }
  return entries;
}

export async function captureSendBaseline(page: ComposerSubmitPage): Promise<SendBaseline> {
  const url = page.url();
  const turnCount = await page.locator(COMPOSER_TURN_SELECTOR).count();
  let lastTurnTestId: string | null = null;
  if (turnCount > 0) {
    try {
      lastTurnTestId = await page.locator(COMPOSER_TURN_SELECTOR).nth(turnCount - 1).getAttribute('data-testid');
    } catch {
      lastTurnTestId = null;
    }
  }
  const seqs = await readTurnSeqs(page);
  const maxSeq = seqs.reduce((max, entry) => Math.max(max, entry.seq), -1);
  return { url, turnCount, lastTurnTestId, maxSeq };
}

export async function readComposerText(page: ComposerSubmitPage): Promise<string> {
  try {
    return await page.locator(SELECTORS.promptTextarea[0]).first().innerText();
  } catch {
    return '';
  }
}
async function readTurnText(page: ComposerSubmitPage, index: number): Promise<string | null> {
  try {
    return await page.locator(COMPOSER_TURN_SELECTOR).nth(index).innerText();
  } catch {
    return null;
  }
}

async function observeSubmission(page: ComposerSubmitPage, prompt: string, baseline: SendBaseline, budgetMs: number): Promise<SendAcknowledgment | null> {
  const expected = normalizeComposedText(prompt);
  const deadline = Date.now() + Math.max(1, budgetMs);
  for (;;) {
    if (page.url() !== baseline.url) {
      throw new Error('Target URL changed during submit; refusing to correlate turns across conversations.');
    }
    const seqs = await readTurnSeqs(page);
    const fresh = seqs.filter((entry) => entry.seq > baseline.maxSeq);
    if (fresh.length > 0) {
      const first = fresh[0];
      const rawText = await readTurnText(page, first.index);
      const text = rawText === null ? null : stripPostedChrome(rawText);
      const normalized = text === null ? '' : normalizeComposedText(text);
      if (normalized.length > 0 && expected.length > 0 && normalized !== expected) {
        throw new Error('New user turn text does not match the submitted prompt; refusing to claim this send.');
      }
      const composerEmpty = normalizeComposedText(await readComposerText(page)).length === 0;
      if (normalized.length > 0 || composerEmpty) {
        return { url: baseline.url, userTurnIndex: first.index, userTurnSeq: first.seq, ackTurnCount: seqs.length, userTurnText: normalized.length > 0 ? normalized : null };
      }
    }
    if (Date.now() >= deadline) return null;
    await wait(500);
  }
}

async function clickFirstVisible(page: ComposerSubmitPage, selectors: readonly string[]): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const total = await locator.count();
    for (let index = total - 1; index >= 0; index--) {
      const candidate = locator.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      try {
        await candidate.click({ timeout: 10000 });
        return true;
      } catch {
        // Try the next visible candidate, then the keyboard fallback.
      }
    }
  }
  return false;
}
/**
 * Submit the composed prompt and prove the delivery. Click-first preserves
 * the established path; when the composer grid intercepts pointer events
 * (or a click succeeds without registering a submission) it falls back to
 * programmatic focus plus a single keyboard Enter, which the editor honors.
 * The fallback runs only while the exact prompt still sits in the composer:
 * a cleared composer without an acknowledgment is ambiguous, and pressing
 * Enter there could double-send, so that path fails closed instead.
 */
export interface SubmitBudgets {
  clickAckMs?: number;
  enterAckMs?: number;
}

export async function submitComposedPrompt(page: ComposerSubmitPage, prompt: string, baseline: SendBaseline, budgets?: SubmitBudgets): Promise<SendAcknowledgment> {
  if (page.url() !== baseline.url) {
    throw new Error('Submit started on a different conversation than the send baseline.');
  }
  await clickFirstVisible(page, SELECTORS.sendButton);
  const clickAckMs = budgets?.clickAckMs ?? 8000;
  const enterAckMs = budgets?.enterAckMs ?? 15000;
  const ack = await observeSubmission(page, prompt, baseline, clickAckMs);
  if (ack) { console.error(`[submit] click-path acknowledged userTurnIndex=${ack.userTurnIndex}`); return ack; }
  if (normalizeComposedText(prompt).length === 0
    || normalizeComposedText(await readComposerText(page)) !== normalizeComposedText(prompt)) {
    throw new Error('Send produced no delivery acknowledgment and the composer no longer holds the exact prompt; refusing a blind Enter that could double-send.');
  }
  await page.locator(SELECTORS.promptTextarea[0]).first().focus();
  await page.keyboard.press('Enter');
  console.error(`[submit] enter-fallback submitted once, awaiting acknowledgment`);
  const retry = await observeSubmission(page, prompt, baseline, enterAckMs);
  if (retry) { console.error(`[submit] enter-fallback acknowledged userTurnIndex=${retry.userTurnIndex}`); return retry; }
  throw new Error('Prompt submission was not observed after send click and one keyboard submit.');
}

/**
 * Verify the composer holds the exact prompt, re-entering it at most once.
 *
 * Long typing runs can outlive one editor mount: the page may remount the
 * composer mid-typing and drop already-typed content (observed live as only
 * the prompt tail surviving). Re-entry is input repair, not a send: it performs
 * no send click and no Enter, and the fail-closed submit contract below still
 * governs every delivery. A second mismatch fails closed without sending.
 */
export async function ensureExactComposer(
  page: ComposerSubmitPage,
  prompt: string,
  typeFn: (selectors: readonly string[], text: string) => Promise<boolean> = (s, t) => typeText(s, t),
): Promise<void> {
  await wait(500);
  if (normalizeComposedText(await readComposerText(page)) !== normalizeComposedText(prompt)) {
    console.error('[send] composer-mismatch-after-typing retype-once');
    appendStageEvent({ scope: 'send', stage: 'composer-retype' });
    const retyped = await typeFn(SELECTORS.promptTextarea, prompt);
    if (!retyped) {
      throw new Error('Failed to find prompt textarea. The ChatGPT UI may have changed.');
    }
    await wait(500);
  }
  if (normalizeComposedText(await readComposerText(page)) !== normalizeComposedText(prompt)) {
    throw new Error('Composer does not hold the exact prompt after typing; send was not attempted.');
  }
}

/**
 * Send a prompt to ChatGPT by typing into the textarea and proving the
 * delivery through the fail-closed submit contract. Returns the delivery
 * acknowledgment so the response poll can anchor on turns that strictly
 * follow the new user turn instead of stale pre-send content.
 */
async function sendPromptText(prompt: string, targetUrl?: string): Promise<SendAcknowledgment> {
  const page = await getPage(targetUrl);
  const baseline = await captureSendBaseline(page);
  console.error('[send] baseline-captured composer-typing-begin');
  appendStageEvent({ scope: 'send', stage: 'baseline-captured' });
  const typed = await typeText(SELECTORS.promptTextarea, prompt);
  if (!typed) {
    throw new Error('Failed to find prompt textarea. The ChatGPT UI may have changed.');
  }

  await ensureExactComposer(page, prompt);

  console.error('[send] composer-holds-exact-prompt submit-begin');
  appendStageEvent({ scope: 'send', stage: 'composer-verified-submit-begin' });
  const ack = await submitComposedPrompt(page, prompt, baseline);

  await wait(1000);

  // Extract conversation ID from URL
  const url = page.url();
  const match = url.match(/\/c\/([A-Za-z0-9-]+)(?:$|[?#])/);
  if (match) {
    sessionState.conversationId = match[1];
  }
  return ack;
}

// ============================================
// Blocking poll loop
// ============================================

/**
 * Poll until generation is complete or deadline is reached.
 * Returns the response text.
 */
async function pollUntilComplete(
  timeoutMinutes: number,
  anchor?: PollAnchor,
  observe?: (afterUserTurnSeq: number) => Promise<FreshTurnSnapshot>,
): Promise<{ response: string; pollCount: number; elapsedSeconds: number }> {
  const startTime = Date.now();
  const deadline = startTime + timeoutMinutes * 60 * 1000;
  let pollCount = 0;
  let progress: PollProgress = { contentLength: 0, stableCount: 0 };
  const afterUserTurnSeq = anchor?.afterUserTurnSeq ?? -1;
  const observeFn = observe ?? (async (seq: number) => observeFreshTurns(await getPage(), seq));
  while (Date.now() < deadline) {
    const waitMs = fibonacciBackoff(pollCount);
    await sleep(waitMs);
    pollCount++;

    const snapshot = await observeFn(afterUserTurnSeq);
    console.error(`[poll] turns=${snapshot.turnCount} fresh=${snapshot.freshAssistantTexts.length} lastFreshCopy=${snapshot.lastFreshHasCopy} thinking=${snapshot.thinking} stable=${progress.stableCount}`);
    const decision = decidePollCompletion(progress, snapshot);
    progress = { contentLength: decision.contentLength, stableCount: decision.stableCount };

    if (decision.complete) {
      const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
      // Save cookies after successful response
      await saveStorageState();
      return {
        response: decision.response ?? '',
        pollCount,
        elapsedSeconds,
      };
    }
  }

  // Timeout
  const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
  throw new Error(
    `Timeout after ${timeoutMinutes} minutes (${elapsedSeconds}s). Response may still be generating.`
  );
}

// ============================================
// Model selection (from gpt-bridge — robust dropdown discovery)
// ============================================

/**
 * Select a model/mode in ChatGPT. Handles dropdown discovery with dynamic option scanning.
 */
export async function selectModel(modelName: string): Promise<string | null> {
  const page = await getPage();

  // Check current model
  const currentModel = await page.evaluate(() => {
    const selectors = [
      'button[aria-label="Model selector"]',
      'button[aria-haspopup="menu"]',
      '[data-testid="model-selector"]',
    ];
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn) {
        const text = btn.textContent?.trim();
        if (text && (text.includes('GPT') || text.includes('Pro') || text.includes('4o'))) {
          return text;
        }
      }
    }
    return null;
  });

  if (currentModel?.toLowerCase().includes(modelName.toLowerCase())) {
    sessionState.currentModel = currentModel;
    return currentModel;
  }

  // Click model selector button
  const clicked = await page.evaluate(() => {
    const modelSelectorBtn = document.querySelector('button[aria-label="Model selector"]') as HTMLElement;
    if (modelSelectorBtn) {
      modelSelectorBtn.click();
      return true;
    }
    const allButtons = document.querySelectorAll('button');
    for (const btn of allButtons) {
      const text = btn.textContent?.trim() || '';
      const rect = btn.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && rect.width < 300 &&
          (text.includes('GPT') || text.includes('Pro') || text.includes('4o') || text.includes('ChatGPT'))) {
        (btn as HTMLElement).click();
        return true;
      }
    }
    return false;
  });

  if (!clicked) {
    throw new Error('Failed to find model selector button.');
  }

  await wait(2000);

  // Find and click the target model in the dropdown
  const result = await page.evaluate((targetInput) => {
    const targetLower = targetInput.toLowerCase().trim();

    const getOptionText = (el: Element): string => {
      const text = el.textContent?.trim() || '';
      const firstLine = text.split('\n')[0].trim();
      const mainText = firstLine.split('Decides')[0].split('Answers')[0].split('Thinks')[0].split('Research')[0].trim();
      return mainText.length > 0 && mainText.length < 40 ? mainText : firstLine.substring(0, 40);
    };

    // Find dropdown container
    const containerSelectors = [
      '[data-radix-popper-content-wrapper]',
      '[role="menu"]',
      '[role="listbox"]',
      '[data-state="open"]',
      '[class*="popover"]',
      '[class*="dropdown"]',
      '[class*="menu"]',
    ];

    let dropdownContainer: Element | null = null;
    for (const selector of containerSelectors) {
      const containers = document.querySelectorAll(selector);
      for (const container of containers) {
        const rect = (container as HTMLElement).getBoundingClientRect();
        if (rect.width > 50 && rect.height > 50) {
          dropdownContainer = container;
          break;
        }
      }
      if (dropdownContainer) break;
    }

    // Fallback: positioned overlay
    if (!dropdownContainer) {
      const allDivs = document.querySelectorAll('div');
      for (const el of allDivs) {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const isPositioned = style.position === 'fixed' || style.position === 'absolute';
        const hasReasonableSize = rect.width > 100 && rect.height > 100 && rect.width < 600 && rect.height < 700;
        const notFullScreen = rect.width < window.innerWidth * 0.8;

        if (isPositioned && hasReasonableSize && notFullScreen) {
          const text = el.textContent || '';
          const hasMenuIndicators =
            text.includes('Auto') || text.includes('Instant') || text.includes('Thinking') ||
            text.includes('Pro') || text.includes('Legacy') || text.includes('GPT') ||
            el.querySelector('[role="menuitem"], [role="option"], button, [data-radix]');
          if (hasMenuIndicators) {
            dropdownContainer = el;
            break;
          }
        }
      }
    }

    if (!dropdownContainer) {
      return { success: false, selected: null, available: [] as string[] };
    }

    // Find menu items
    const candidateSelectors = [
      '[role="menuitem"]',
      '[role="option"]',
      '[data-radix-collection-item]',
      'button',
      'a',
      'div[tabindex]',
      'div[class*="item"]',
      'div[class*="option"]',
    ];

    const availableOptions: Array<{ text: string; element: Element }> = [];
    const seenTexts = new Set<string>();
    const modePatterns = /^(Auto|Instant|Thinking|Pro|Legacy|GPT|ChatGPT)/i;

    for (const selector of candidateSelectors) {
      const items = dropdownContainer.querySelectorAll(selector);
      for (const item of items) {
        const rect = (item as HTMLElement).getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0 || rect.height < 20 || rect.height > 100) continue;
        const text = getOptionText(item);
        if (text.length < 2 || text.length > 50 || seenTexts.has(text)) continue;
        const skipPatterns = ['how long', 'right away', 'longer for', 'Close', 'Back'];
        if (skipPatterns.some(p => text.toLowerCase().includes(p.toLowerCase()))) continue;
        if (modePatterns.test(text)) {
          seenTexts.add(text);
          availableOptions.push({ text, element: item });
        }
      }
    }

    // Match: exact → starts with → contains
    for (const opt of availableOptions) {
      if (opt.text.toLowerCase() === targetLower) {
        (opt.element as HTMLElement).click();
        return { success: true, selected: opt.text, available: availableOptions.map(o => o.text) };
      }
    }
    for (const opt of availableOptions) {
      if (opt.text.toLowerCase().startsWith(targetLower)) {
        (opt.element as HTMLElement).click();
        return { success: true, selected: opt.text, available: availableOptions.map(o => o.text) };
      }
    }
    for (const opt of availableOptions) {
      if (opt.text.toLowerCase().includes(targetLower)) {
        (opt.element as HTMLElement).click();
        return { success: true, selected: opt.text, available: availableOptions.map(o => o.text) };
      }
    }

    return { success: false, selected: null, available: availableOptions.map(o => o.text) };
  }, modelName);

  if (!result.success) {
    await page.keyboard.press('Escape');
    await wait(300);
    const availableStr = result.available.length > 0 ? result.available.join(', ') : 'none detected';
    throw new Error(`"${modelName}" not found. Available options: ${availableStr}`);
  }

  await wait(500);
  sessionState.currentModel = result.selected || modelName;
  return result.selected || modelName;
}

// ============================================
// Project selection (from gpt-bridge)
// ============================================

/**
 * Select a project by name. Finds /g/g-p-* links and navigates.
 */
export async function selectProject(projectName: string): Promise<SimpleResult> {
  try {
    await ensureSession();
    const page = await getPage();

    const projectUrl = await page.evaluate((name) => {
      const projectLinks = document.querySelectorAll('a[href*="/g/g-p-"]');

      // Exact match first
      for (const el of projectLinks) {
        const href = el.getAttribute('href') || '';
        if (href.includes('/project')) {
          const linkText = el.textContent?.trim().toLowerCase();
          if (linkText === name.toLowerCase()) return href;
        }
      }

      // Partial match
      for (const el of projectLinks) {
        const href = el.getAttribute('href') || '';
        if (href.includes('/project')) {
          const linkText = el.textContent?.trim().toLowerCase();
          if (linkText?.includes(name.toLowerCase())) return href;
        }
      }

      return null;
    }, projectName);

    if (!projectUrl) {
      return {
        success: false,
        message: `Project "${projectName}" not found in sidebar.`,
      };
    }

    const fullUrl = projectUrl.startsWith('http') ? projectUrl : `https://chatgpt.com${projectUrl}`;
    await page.goto(fullUrl, { waitUntil: 'domcontentloaded' });
    await wait(2000);

    sessionState.currentProjectUrl = fullUrl;
    sessionState.conversationId = null;

    return {
      success: true,
      message: `Selected project: ${projectName}. New conversations will stay within this project.`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to select project: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================
// New conversation
// ============================================

/**
 * Start a new conversation. Stays within current project if set.
 */
export async function newConversation(): Promise<SimpleResult> {
  try {
    await ensureSession();

    // Stay in current project, or navigate to default project URL if set
    const targetUrl = sessionState.currentProjectUrl || CONFIG.chatgptUrl;
    await navigateTo(targetUrl);
    await wait(1500);

    sessionState.conversationId = null;

    const inProject = sessionState.currentProjectUrl ? ' within current project' : '';
    return {
      success: true,
      message: `New conversation started${inProject}.`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to start new conversation: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================
// Core blocking tools
// ============================================

/**
 * blockingAsk — the primary tool. Send prompt, poll until complete, return response.
 */
export async function blockingAsk(
  prompt: string,
  model?: string,
  project?: string,
  timeoutMinutes = 60,
): Promise<AskResult> {
  try {
    await ensureSession();

    // Navigate to project if specified and different from current
    if (project) {
      const page = await getPage();
      const currentUrl = page.url();
      const needsProjectSwitch = !sessionState.currentProjectUrl ||
        !currentUrl.includes('/g/g-p-');

      if (needsProjectSwitch) {
        const result = await selectProject(project);
        if (!result.success) {
          return {
            response: '',
            elapsed_seconds: 0,
            model: null,
            chat_id: null,
            poll_count: 0,
            error: result.message,
          };
        }
      }
    }

    // Switch model if specified
    if (model) {
      try {
        await selectModel(model);
      } catch (error) {
        return {
          response: '',
          elapsed_seconds: 0,
          model: null,
          chat_id: null,
          poll_count: 0,
          error: `Model selection failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    // Send prompt; the poll anchors on turns after the acked user turn.
    const askAck = await sendPromptText(prompt);

    // Poll until complete
    const result = await pollUntilComplete(timeoutMinutes, { afterUserTurnSeq: askAck.userTurnSeq });

    return {
      response: result.response,
      elapsed_seconds: result.elapsedSeconds,
      model: sessionState.currentModel,
      chat_id: sessionState.conversationId,
      poll_count: result.pollCount,
    };
  } catch (error) {
    return {
      response: '',
      elapsed_seconds: 0,
      model: null,
      chat_id: null,
      poll_count: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * blockingReply — same polling loop but no project/model switching.
 * Operates in the current conversation.
 */
export async function blockingReply(
  prompt: string,
  timeoutMinutes = 60,
  options: BlockingReplyOptions = {},
): Promise<AskResult> {
  // Diagnostic stage only: last completed phase for stderr on failure.
  // Never added to the AskResult schema, never retried, never resent.
  let stage = 'target-resolution';
  let stageConversationId: string | null = null;
  try {
    // Resolve and validate the target before opening/typing in the browser.
    // Legacy callers omit options and retain the historical current-chat
    // behavior.
    const target = resolveReplyTarget(options);
    stage = 'target-resolved';
    stageConversationId = target?.conversationId ?? null;
    appendStageEvent({ scope: 'reply', stage, conversation_id: stageConversationId });
    await ensureSession(target || undefined);
    stage = 'session-ensured';
    appendStageEvent({ scope: 'reply', stage, conversation_id: stageConversationId });

    if (target) {
      await ensureReplyTarget(target);
      stage = 'target-ensured';
    appendStageEvent({ scope: 'reply', stage, conversation_id: stageConversationId });
    }

    stage = 'submit-begin';
    appendStageEvent({ scope: 'reply', stage, conversation_id: stageConversationId });
    const replyAck = await sendPromptText(prompt, target?.url);
    stage = 'user-turn-acknowledged';
    appendStageEvent({ scope: 'reply', stage, conversation_id: stageConversationId });

    stage = 'assistant-turn-wait';
    appendStageEvent({ scope: 'reply', stage, conversation_id: stageConversationId });
    const result = await pollUntilComplete(timeoutMinutes, { afterUserTurnSeq: replyAck.userTurnSeq });
    stage = 'assistant-turn-waited';
    appendStageEvent({ scope: 'reply', stage, conversation_id: stageConversationId });

    if (target) {
      // A successful poll is not sufficient evidence that the response came
      // from the frozen conversation. Re-read and validate the canonical URL
      // after generation so a redirect/tab switch becomes an explicit error.
      const page = await getPage(target.url);
      const finalTarget = parseChatGPTTargetUrl(page.url());
      if (finalTarget.url !== target.url || finalTarget.conversationId !== target.conversationId) {
        throw new Error('Target conversation identity mismatch after response.');
      }
      sessionState.conversationId = finalTarget.conversationId;
    }
    stage = 'target-reverified';
    appendStageEvent({ scope: 'reply', stage, conversation_id: stageConversationId });

    return {
      response: result.response,
      elapsed_seconds: result.elapsedSeconds,
      model: sessionState.currentModel,
      chat_id: sessionState.conversationId,
      poll_count: result.pollCount,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[reply] stage=${stage} error=${message}`);
    if (error instanceof Error && error.stack) console.error(`[reply] stack=${error.stack}`);
    appendStageEvent({ scope: 'reply', stage, status: 'failed', conversation_id: stageConversationId, error: message, stack: error instanceof Error ? (error.stack ?? null) : null });
    return {
      response: '',
      elapsed_seconds: 0,
      model: null,
      chat_id: null,
      poll_count: 0,
      error: message,
    };
  }
}

// ============================================
// File upload
// ============================================

/**
 * Upload files and optionally send a prompt, then poll for response.
 */
export async function uploadFiles(
  filePaths: string[],
  prompt?: string,
  timeoutMinutes = 60,
): Promise<AskResult> {
  try {
    await ensureSession();
    const page = await getPage();

    // Upload files by setting them directly on the hidden <input type="file"> element.
    // This is more reliable than clicking the attach button (whose selector changes frequently)
    // and avoids dangerous fallback searches that could click wrong elements.
    const fileInputSet = await page.evaluate(() => {
      const inputs = document.querySelectorAll('input[type="file"]');
      return inputs.length;
    });

    if (fileInputSet === 0) {
      throw new Error('No file input found on page. ChatGPT may not support file upload in this state.');
    }

    // Use Playwright's setInputFiles on the first file input
    await page.setInputFiles('input[type="file"]', filePaths);

    // Wait for upload indicators to appear and settle
    await wait(3000);

    // If prompt provided, type it
    if (prompt) {
      const typed = await typeText(SELECTORS.promptTextarea, prompt);
      if (!typed) {
        throw new Error('Failed to type prompt after file upload.');
      }
    }

    // Send through the shared fail-closed submit contract. The baseline is
    // captured before typing so the acknowledgment anchors on this upload. 
    await wait(500);
    const uploadBaseline = await captureSendBaseline(page);
    const uploadAck = await submitComposedPrompt(page, prompt ?? '', uploadBaseline);

    await wait(1000);

    // Extract conversation ID
    const url = page.url();
    const match = url.match(/\/c\/([a-f0-9-]+)/);
    if (match) {
      sessionState.conversationId = match[1];
    }

    // Poll until complete
    const result = await pollUntilComplete(timeoutMinutes, { afterUserTurnSeq: uploadAck.userTurnSeq });

    return {
      response: result.response,
      elapsed_seconds: result.elapsedSeconds,
      model: sessionState.currentModel,
      chat_id: sessionState.conversationId,
      poll_count: result.pollCount,
    };
  } catch (error) {
    return {
      response: '',
      elapsed_seconds: 0,
      model: null,
      chat_id: null,
      poll_count: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
