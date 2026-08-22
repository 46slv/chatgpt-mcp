import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseNaturalDirective } from './dev-exec-natural-protocol.mjs';

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

function parse(extracted) {
  return parseNaturalDirective(extracted, {
    defaultWorkingDirectory: 'C:\\Fallback',
    defaultTimeoutSeconds: 240,
  });
}

test('Bridge cleaner -> Natural Protocol preserves rendered multiline PowerShell end to end', () => {
  // Browser innerText commonly exposes the rendered code language as a standalone
  // label rather than preserving Markdown backticks. This is the important real UI shape.
  const renderedTurn = [
    'ChatGPT said:',
    'RUN WorkingDirectory: C:\\Work TimeoutSeconds: 300',
    'powershell',
    '$x = 1',
    'Write-Output $x',
  ].join('\n');

  const extracted = cleanText(renderedTurn);
  assert.match(extracted, /powershell\n\$x = 1\nWrite-Output \$x/);

  const directive = parse(extracted);
  assert.equal(directive.decision, 'RUN');
  assert.equal(directive.workingDirectory, 'C:\\Work');
  assert.equal(directive.timeoutSeconds, 300);
  assert.equal(directive.script, '$x = 1\nWrite-Output $x');
});

test('Bridge cleaner -> Natural Protocol also preserves literal fenced multiline RUN', () => {
  const renderedTurn = [
    'RUN WorkingDirectory: C:\\Work TimeoutSeconds: 300',
    '```powershell',
    '$x = 1',
    'Write-Output $x',
    '```',
  ].join('\n');

  const directive = parse(cleanText(renderedTurn));
  assert.equal(directive.script, '$x = 1\nWrite-Output $x');
});

test('producer -> Natural Protocol preserves chrome-like payload text exactly', () => {
  const payloadLines = [
    'Write-Output "ChatGPT said:"',
    'Write-Output "Thinking..."',
    'Write-Output "Answer now"',
    'Write-Output "bullet • value"',
    'Write-Output "15 seconds"',
  ];
  const renderedTurn = [
    'Thinking...',
    'ChatGPT said:',
    'RUN WorkingDirectory: C:\\Work TimeoutSeconds: 300',
    'powershell',
    ...payloadLines,
  ].join('\n');

  const extracted = cleanText(renderedTurn);
  const directive = parse(extracted);
  assert.equal(directive.decision, 'RUN');
  assert.equal(directive.workingDirectory, 'C:\\Work');
  assert.equal(directive.timeoutSeconds, 300);
  assert.equal(directive.script, payloadLines.join('\n'));
});
