import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const chatgptSource = readFileSync(
  new URL('../src/chatgpt.ts', import.meta.url),
  'utf8',
);

const phrasesMatch = chatgptSource.match(
  /const phrasesToRemove = \[\n([\s\S]*?)\n      \];/,
);
const cleanTextMatch = chatgptSource.match(
  /const cleanText = \(text: string\): string => \{\n([\s\S]*?)\n      \};/,
);

assert.ok(phrasesMatch, 'phrasesToRemove must remain discoverable');
assert.ok(cleanTextMatch, 'cleanText implementation must remain discoverable');

const cleanText = new Function(
  `const phrasesToRemove = [\n${phrasesMatch[1]}\n];\nconst cleanText = (text) => {\n${cleanTextMatch[1]}\n};\nreturn cleanText;`,
)();

const directiveBody = [
  'RUN WorkingDirectory: C:\\Work TimeoutSeconds: 300',
  'powershell',
  'Write-Output "ok"',
].join('\n');

test('mixed prefix: timing then chrome is fully removed before RUN', () => {
  const input = ['15 seconds', 'Thinking...', 'ChatGPT said:', directiveBody].join('\n');
  assert.equal(cleanText(input), directiveBody);
});

test('mixed prefix: chrome then timing then chrome is fully removed before RUN', () => {
  const input = ['Thinking...', '15 secs', 'ChatGPT said:', directiveBody].join('\n');
  assert.equal(cleanText(input), directiveBody);
});

test('timing and chrome-like strings remain untouched after RUN begins', () => {
  const payload = [
    'RUN WorkingDirectory: C:\\Work TimeoutSeconds: 300',
    'powershell',
    'Write-Output "15 seconds"',
    'Write-Output "Thinking..."',
    'Write-Output "ChatGPT said:"',
  ].join('\n');
  assert.equal(cleanText(payload), payload);
});
