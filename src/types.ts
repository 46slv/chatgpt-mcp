// Types and configuration for chatgpt-mcp

import os from 'node:os';
import path from 'node:path';

// ============================================
// Result interfaces
// ============================================

export interface AskResult {
  response: string;
  elapsed_seconds: number;
  model: string | null;
  chat_id: string | null;
  poll_count: number;
  error?: string;
}

export interface SimpleResult {
  success: boolean;
  message: string;
  error?: string;
}

export type GenerationStatus = 'idle' | 'generating' | 'complete' | 'error';

export interface SessionState {
  isLoggedIn: boolean;
  currentModel: string | null;
  conversationId: string | null;
  currentProjectUrl: string | null;
}

// ============================================
// ChatGPT DOM selectors — multiple fallbacks for resilience
// ============================================

export const SELECTORS = {
  // Prompt input area
  promptTextarea: [
    '#prompt-textarea',
    '[data-testid="prompt-textarea"]',
    'textarea[placeholder*="Message"]',
    'div[contenteditable="true"]',
  ],

  // Send button
  sendButton: [
    '[data-testid="send-button"]',
    'button[aria-label*="Send"]',
    'button[data-testid="composer-send-button"]',
  ],

  // Stop generating button (presence = still generating)
  stopButton: [
    '[data-testid="stop-button"]',
    'button[aria-label*="Stop"]',
    'button:has-text("Stop generating")',
  ],

  // Regenerate button (presence = generation complete)
  regenerateButton: [
    '[data-testid="regenerate-button"]',
    'button:has-text("Regenerate")',
  ],

  // Assistant response messages
  responseContainer: [
    '[data-message-author-role="assistant"]',
    '.agent-turn',
    '[data-testid*="conversation-turn"]:last-child',
  ],

  // Model selector
  modelSelector: [
    '[data-testid="model-selector"]',
    'button:has-text("GPT")',
    '[aria-haspopup="menu"]:has-text("GPT")',
  ],

  // New chat button
  newChatButton: [
    '[data-testid="new-chat-button"]',
    'a[href="/"]',
    'button:has-text("New chat")',
  ],

  // Login indicator (if present, user is logged in)
  loggedInIndicator: [
    '[data-testid="profile-button"]',
    'button[aria-label*="Profile"]',
    'img[alt*="User"]',
  ],

  // Login prompt (if present, user needs to log in)
  loginPrompt: [
    'button:has-text("Log in")',
    'a:has-text("Log in")',
    '[data-testid="login-button"]',
  ],

  // Attach/upload button
  attachButton: [
    '[data-testid="composer-action-file-upload"]',
    '[data-testid="composer-attach-button"]',
    'button[aria-label*="Attach"]',
    'button[aria-label*="Upload"]',
    'button[aria-label*="attach"]',
  ],
} as const;

// ============================================
// Configuration
// ============================================

function resolveUserDataDir(): string {
  const override = process.env.CHATGPT_MCP_USER_DATA_DIR;
  if (override && override.trim()) return override.trim();

  // os.homedir() is the platform-aware source on Node. The environment
  // fallback keeps startup usable in constrained Windows shells/test hosts.
  let home = '';
  try {
    home = os.homedir();
  } catch {
    home = '';
  }
  if (!home) home = process.env.USERPROFILE || process.env.HOME || '.';
  return path.join(home, '.chatgpt-mcp', 'user-data');
}

/**
 * Identity of a user-prepared ChatGPT conversation.  Targeted replies use
 * this value as a runner-owned contract; the URL and conversation id must
 * describe the same canonical conversation.
 */
export interface ChatGPTTargetIdentity {
  url: string;
  conversationId: string;
}

/**
 * Parse the only URL form accepted for a targeted ChatGPT reply.
 *
 * Keep this validator equivalent to tools/target-registry.mjs: accepting a
 * URL that the registry would reject would let a runner freeze one identity
 * and the MCP server operate on another.  Deliberately reject URL forms that
 * URL() would otherwise normalize (ports, credentials, query, fragments,
 * trailing slash, alternate host, or extra path components).
 */
export function parseChatGPTTargetUrl(value: unknown): ChatGPTTargetIdentity {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error('Target URL must be an exact non-empty string.');
  }

  const match = /^https:\/\/chatgpt\.com\/c\/([A-Za-z0-9-]+)$/.exec(value);
  if (!match) {
    throw new Error(
      'Target URL must exactly match https://chatgpt.com/c/<safe-id> without query, fragment, port, userinfo, trailing slash, or extra path.'
    );
  }

  const parsed = new URL(value);
  if (
    parsed.origin !== 'https://chatgpt.com' ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== `/c/${match[1]}`
  ) {
    throw new Error('Target URL is not canonical.');
  }

  return { url: value, conversationId: match[1] };
}

/** Validate a runner-owned conversation id using the same safe-id contract. */
export function validateConversationId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]+$/.test(value)) {
    throw new Error('Expected conversation id is invalid.');
  }
  return value;
}

export const CONFIG = {
  chatgptUrl: 'https://chatgpt.com',
  userDataDir: resolveUserDataDir(),
  defaultTimeout: 30000,
  typingDelay: 50,
  pollInterval: 5000,
  stableThreshold: 3, // More conservative than gpt-bridge's 2
  maxWaitTime: 3600000,
  // Default project — all new chats go here unless overridden.
  // This is the ChatGPT project name as shown in the sidebar.
  defaultProject: 'claude',
} as const;
