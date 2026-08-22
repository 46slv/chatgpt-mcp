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

const payloadLines = [
  'Write-Output "ChatGPT said:"',
  'Write-Output "Thinking..."',
  'Write-Output "Answer now"',
  'Write-Output "bullet • value"',
];

function renderedTurn() {
  return [
    'ChatGPT said:',
    'RUN WorkingDirectory: C:\\Work TimeoutSeconds: 300',
    'powershell',
    ...payloadLines,
  ].join('\n');
}

test('Bridge chrome cleanup never rewrites executable payload text', () => {
  const cleaned = cleanText(renderedTurn());
  for (const line of payloadLines) {
    assert.ok(
      cleaned.split('\n').includes(line),
      `cleaned response must preserve payload line exactly: ${line}\nActual:\n${cleaned}`,
    );
  }
});
