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
  elementExists,
  typeText,
  clickElement,
  wait,
  saveStorageState,
  isBrowserRunning,
  launchBrowser,
} from './browser.js';
import { fibonacciBackoff, sleep } from './utils/backoff.js';

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
  const currentUrl = page.url();
  if (currentUrl !== target.url) {
    const navigated = await dependencies.navigate(target.url);
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

  if (!(await dependencies.isLoggedIn())) {
    throw new Error('ChatGPT session is not logged in at the targeted conversation.');
  }
}

async function ensureReplyTarget(target: ChatGPTTargetIdentity): Promise<void> {
  const page = await getPage();
  await ensureReplyTargetOnPage(page, target, {
    navigate: navigateTo,
    isLoggedIn: checkLoginStatus,
  });
}

// ============================================
// Session management
// ============================================

/**
 * Auto-start session on first call. Not exposed as a tool.
 */
export async function ensureSession(): Promise<void> {
  if (sessionInitialized && isBrowserRunning()) {
    return;
  }

  await launchBrowser();
  const success = await navigateTo(CONFIG.chatgptUrl);
  if (!success) {
    throw new Error('Failed to navigate to ChatGPT');
  }

  // Wait for page to settle, then check login with retries
  // (Cloudflare checks or slow loads can cause false negatives)
  await wait(3000);

  let isLoggedIn = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    isLoggedIn = await checkLoginStatus();
    if (isLoggedIn) break;
    console.error(`[session] Login check attempt ${attempt + 1} failed, retrying...`);
    await wait(3000);
  }

  sessionState.isLoggedIn = isLoggedIn;
  sessionInitialized = true;

  if (!isLoggedIn) {
    throw new Error(
      'Not logged in to ChatGPT. Please log in manually in the browser window, then retry.'
    );
  }

  await saveStorageState();

  // Auto-select default project on first launch
  if (CONFIG.defaultProject && !sessionState.currentProjectUrl) {
    const result = await selectProject(CONFIG.defaultProject);
    if (result.success) {
      console.error(`[session] Auto-selected default project: ${CONFIG.defaultProject}`);
    } else {
      console.error(`[session] Default project "${CONFIG.defaultProject}" not found, using home`);
    }
  }
}

/**
 * Check if user is logged in to ChatGPT
 */
async function checkLoginStatus(): Promise<boolean> {
  const hasLoggedInIndicator = await elementExists(SELECTORS.loggedInIndicator);
  const hasLoginPrompt = await elementExists(SELECTORS.loginPrompt);
  const hasPromptArea = await elementExists(SELECTORS.promptTextarea);

  return (hasLoggedInIndicator || hasPromptArea) && !hasLoginPrompt;
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
async function getLatestResponseText(): Promise<string | null> {
  try {
    const page = await getPage();

    const text = await page.evaluate(() => {
      // UI chrome phrases that appear in turn elements but aren't part of the response
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

      const cleanText = (text: string): string => {
        let cleaned = text;
        for (const phrase of phrasesToRemove) {
          while (cleaned.includes(phrase)) {
            cleaned = cleaned.replace(phrase, '');
          }
        }
        // Remove "Thinking" only as a standalone word at the start
        cleaned = cleaned.replace(/^Thinking\s*/i, '');
        cleaned = cleaned.replace(/Pro\s+thinking\s*\u2022?\s*/gi, '');
        // Remove timing indicators like "15 seconds" but be careful not to strip legitimate numbers
        cleaned = cleaned.replace(/^\d+\s*(seconds?|secs?)\s*/i, '');
        cleaned = cleaned.replace(/\s+/g, ' ').trim();
        return cleaned;
      };

      // Get all conversation turns
      const turns = document.querySelectorAll('[data-testid^="conversation-turn-"]');
      if (turns.length < 2) return null;

      const lastTurn = turns[turns.length - 1] as HTMLElement;

      // Strategy 1: Use innerText of the turn element (respects visibility, skips hidden elements)
      // This is the most reliable because it gets exactly what the user sees
      const innerText = lastTurn.innerText?.trim();
      if (innerText) {
        const cleaned = cleanText(innerText);
        if (cleaned.length > 0) return cleaned;
      }

      // Strategy 2: Clone, strip chrome elements, get textContent
      const clone = lastTurn.cloneNode(true) as Element;
      const chromeSelectors = [
        'button', '[role="button"]',
        '[class*="actions"]', '[class*="toolbar"]',
        'nav', 'header', 'footer',
        '[class*="thinking"]', '[class*="reasoning"]',
        '[data-testid*="thinking"]',
      ];
      for (const sel of chromeSelectors) {
        clone.querySelectorAll(sel).forEach(e => e.remove());
      }
      const stripped = clone.textContent?.trim();
      if (stripped) {
        const cleaned = cleanText(stripped);
        if (cleaned.length > 0) return cleaned;
      }

      // Strategy 3: Look for markdown/prose inside the turn
      const markdown = lastTurn.querySelector('.markdown, .prose, [class*="markdown"]');
      if (markdown) {
        const mdText = markdown.textContent?.trim();
        if (mdText) return cleanText(mdText);
      }

      // Strategy 4: data-message-author-role="assistant" anywhere on page
      const assistantMsgs = document.querySelectorAll('[data-message-author-role="assistant"]');
      if (assistantMsgs.length > 0) {
        const lastMsg = assistantMsgs[assistantMsgs.length - 1] as HTMLElement;
        const msgText = lastMsg.innerText?.trim();
        if (msgText) return cleanText(msgText);
      }

      return null;
    });

    return text;
  } catch (error) {
    console.error('Failed to get response text:', error);
    return null;
  }
}

// ============================================
// Generation completion detection
// ============================================

/**
 * Check if generation is complete.
 *
 * ChatGPT DOM learnings (2026-02):
 * - data-testid="stop-button" persists permanently — UNRELIABLE
 * - data-testid="copy-turn-action-button" inside last turn = response done — RELIABLE
 * - [class*="streaming"] matches unrelated elements — UNRELIABLE
 * - data-is-streaming rarely set — UNRELIABLE
 *
 * Strategy: check if the LAST conversation turn has a copy button inside it,
 * combined with content stability.
 */
async function isGenerationComplete(
  lastContentLength: number,
  stableCount: number,
): Promise<{ complete: boolean; contentLength: number; newStableCount: number }> {
  const page = await getPage();

  const indicators = await page.evaluate(() => {
    const turns = document.querySelectorAll('[data-testid^="conversation-turn-"]');
    const turnCount = turns.length;

    // Check if the LAST turn has a copy button inside it
    // This is the key signal — copy button appears only when that turn is complete
    let lastTurnHasCopy = false;
    // Check if the turn appears to be in a thinking state
    let isThinking = false;
    if (turns.length >= 2) {
      const lastTurn = turns[turns.length - 1];
      lastTurnHasCopy = !!lastTurn.querySelector('[data-testid="copy-turn-action-button"]');

      // Detect thinking state: look for thinking indicators in the turn
      const turnText = (lastTurn as HTMLElement).innerText || '';
      const thinkingPatterns = /\b(thinking|reasoning)\b/i;
      const hasThinkingUI = !!lastTurn.querySelector(
        '[class*="thinking"], [class*="reasoning"], [data-testid*="thinking"]'
      );
      // "Thinking" as a standalone label at the start of the turn content
      isThinking = hasThinkingUI || (thinkingPatterns.test(turnText) && turnText.length < 200);
    }

    return { turnCount, lastTurnHasCopy, isThinking };
  });

  const currentText = await getLatestResponseText();
  const currentLength = currentText?.length ?? 0;

  console.error(`[poll] turns=${indicators.turnCount} lastTurnCopy=${indicators.lastTurnHasCopy} thinking=${indicators.isThinking} contentLen=${currentLength} stable=${stableCount}`);

  // Check content stability
  let newStableCount = stableCount;
  if (currentLength > 0 && currentLength === lastContentLength) {
    newStableCount++;
  } else {
    newStableCount = 0;
  }

  // Complete if:
  // 1. Last turn has copy button AND we have content AND it's been stable for 1 check
  //    (copy button is the authoritative signal — it only appears when generation is truly done)
  // 2. Fallback: content stable for 10+ checks (~3+ minutes) AND not in thinking state
  //    (very conservative — only for edge cases where copy button never appears)
  //
  // BUG FIX: Previously stableThreshold=3 caused false positives during GPT-5.2 Pro's
  // thinking phase, where a thinking summary label would appear stable and trigger completion.
  const FALLBACK_STABLE_THRESHOLD = 10;
  const highConfidence =
    (indicators.lastTurnHasCopy && currentLength > 0 && newStableCount >= 1) ||
    (!indicators.isThinking && currentLength > 0 && newStableCount >= FALLBACK_STABLE_THRESHOLD);

  console.error(`[poll] → complete=${highConfidence}`);

  return {
    complete: highConfidence,
    contentLength: currentLength,
    newStableCount,
  };
}

// ============================================
// Prompt sending
// ============================================

/**
 * Send a prompt to ChatGPT by typing into textarea and clicking send
 */
async function sendPromptText(prompt: string): Promise<void> {
  const typed = await typeText(SELECTORS.promptTextarea, prompt);
  if (!typed) {
    throw new Error('Failed to find prompt textarea. The ChatGPT UI may have changed.');
  }

  await wait(500);

  const sent = await clickElement(SELECTORS.sendButton);
  if (!sent) {
    const page = await getPage();
    await page.keyboard.press('Enter');
  }

  await wait(1000);

  // Extract conversation ID from URL
  const page = await getPage();
  const url = page.url();
  const match = url.match(/\/c\/([A-Za-z0-9-]+)(?:$|[?#])/);
  if (match) {
    sessionState.conversationId = match[1];
  }
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
): Promise<{ response: string; pollCount: number; elapsedSeconds: number }> {
  const startTime = Date.now();
  const deadline = startTime + timeoutMinutes * 60 * 1000;
  let pollCount = 0;
  let lastContentLength = 0;
  let stableCount = 0;

  while (Date.now() < deadline) {
    const waitMs = fibonacciBackoff(pollCount);
    await sleep(waitMs);
    pollCount++;

    const result = await isGenerationComplete(lastContentLength, stableCount);
    lastContentLength = result.contentLength;
    stableCount = result.newStableCount;

    if (result.complete) {
      const response = await getLatestResponseText();
      const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
      // Save cookies after successful response
      await saveStorageState();
      return {
        response: response ?? '',
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

    // Send prompt
    await sendPromptText(prompt);

    // Poll until complete
    const result = await pollUntilComplete(timeoutMinutes);

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
  try {
    // Resolve and validate the target before opening/typing in the browser.
    // Legacy callers omit options and retain the historical current-chat
    // behavior.
    const target = resolveReplyTarget(options);
    await ensureSession();

    if (target) {
      await ensureReplyTarget(target);
    }

    await sendPromptText(prompt);

    const result = await pollUntilComplete(timeoutMinutes);

    if (target) {
      // A successful poll is not sufficient evidence that the response came
      // from the frozen conversation. Re-read and validate the canonical URL
      // after generation so a redirect/tab switch becomes an explicit error.
      const page = await getPage();
      const finalTarget = parseChatGPTTargetUrl(page.url());
      if (finalTarget.url !== target.url || finalTarget.conversationId !== target.conversationId) {
        throw new Error('Target conversation identity mismatch after response.');
      }
      sessionState.conversationId = finalTarget.conversationId;
    }

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

    // Send
    await wait(500);
    const sent = await clickElement(SELECTORS.sendButton);
    if (!sent) {
      await page.keyboard.press('Enter');
    }

    await wait(1000);

    // Extract conversation ID
    const url = page.url();
    const match = url.match(/\/c\/([a-f0-9-]+)/);
    if (match) {
      sessionState.conversationId = match[1];
    }

    // Poll until complete
    const result = await pollUntilComplete(timeoutMinutes);

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
