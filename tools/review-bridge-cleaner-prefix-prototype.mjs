// Review prototype only: pure helper demonstrating the required transport invariant.
// This file is intentionally not wired into production; Worker A can transplant the
// algorithm into src/chatgpt.ts after reviewing browser-shape assumptions.

const LEADING_CHROME = [
  'ChatGPT said:',
  'ChatGPT said',
  'Pro thinking',
  'Answer now',
  'Extended thinking',
  'Show thinking',
  'Hide thinking',
  'Reasoning',
  'Thinking...',
  'Thinking…',
  '• ',
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove only leading UI chrome. Never search-and-replace through response payload.
 * Newlines are normalized because the Natural Protocol already treats LF as its
 * canonical physical-line separator.
 */
export function cleanBridgeResponseTextPrefixOnly(text) {
  let cleaned = String(text ?? '').replace(/\r\n?/g, '\n').trim();

  // Repeatedly peel known chrome only when it occurs at the current beginning.
  // This handles stacked labels such as "Thinking...\nPro thinking •\nChatGPT said:".
  let changed = true;
  while (changed && cleaned) {
    changed = false;
    for (const phrase of LEADING_CHROME) {
      const match = cleaned.match(new RegExp(`^\\s*${escapeRegExp(phrase)}\\s*`, 'i'));
      if (!match) continue;
      cleaned = cleaned.slice(match[0].length);
      changed = true;
      break;
    }
  }

  // Keep the existing leading timing cleanup, but anchor it to the beginning only.
  cleaned = cleaned.replace(/^\s*\d+\s*(seconds?|secs?)\s*/i, '');
  return cleaned.trim();
}
