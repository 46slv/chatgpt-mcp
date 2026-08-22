export const phrasesToRemove = [
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

export function cleanLeadingUiPrefix(text) {
  let cleaned = String(text).replace(/\r\n?/g, '\n').trim();
  let changed = true;

  while (changed && cleaned) {
    changed = false;

    for (const phrase of phrasesToRemove) {
      const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = cleaned.match(new RegExp(`^\\s*${escaped}\\s*`, 'i'));
      if (!match) continue;
      cleaned = cleaned.slice(match[0].length);
      changed = true;
      break;
    }

    if (changed) continue;

    const timing = cleaned.match(/^\s*\d+\s*(seconds?|secs?)\s*/i);
    if (timing) {
      cleaned = cleaned.slice(timing[0].length);
      changed = true;
    }
  }

  return cleaned.trim();
}
