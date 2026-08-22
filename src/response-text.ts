const RESPONSE_UI_PHRASES = [
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

/**
 * Remove ChatGPT turn chrome without destroying response structure.
 *
 * The Bridge may transport executable fenced blocks, so interior whitespace is
 * data. In particular, never normalize all `\s` to spaces here: that turns a
 * multiline PowerShell response into one syntactically different line.
 */
export function cleanExtractedResponseText(text: string): string {
  let cleaned = text.replace(/\r\n?/g, '\n');

  for (const phrase of RESPONSE_UI_PHRASES) {
    while (cleaned.includes(phrase)) {
      cleaned = cleaned.replace(phrase, '');
    }
  }

  // Remove "Thinking" only as a standalone label at the start.
  cleaned = cleaned.replace(/^Thinking\s*/i, '');
  cleaned = cleaned.replace(/Pro\s+thinking\s*\u2022?\s*/gi, '');

  // Remove a leading UI timing indicator such as "15 seconds" while leaving
  // legitimate numbers elsewhere untouched.
  cleaned = cleaned.replace(/^\d+\s*(seconds?|secs?)\s*/i, '');

  return cleaned.trim();
}
