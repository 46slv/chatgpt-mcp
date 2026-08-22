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

assert.ok(phrasesMatch, 'phrasesToRemove must remain discoverable by the regression test');
assert.ok(cleanTextMatch, 'cleanText implementation must remain discoverable by the regression test');

const cleanText = new Function(
  `const phrasesToRemove = [\n${phrasesMatch[1]}\n];\nconst cleanText = (text) => {\n${cleanTextMatch[1]}\n};\nreturn cleanText;`,
)();

test('source does not collapse all whitespace into spaces', () => {
  assert.doesNotMatch(chatgptSource, /cleaned\s*=\s*cleaned\.replace\(\/\\s\+\/g, ['"] ['"]\)/);
});

test('preserves fenced multiline PowerShell structure and indentation', () => {
  const input = [
    'ChatGPT said:',
    '15 seconds',
    'RUN',
    '```powershell',
    'Set-Location "D:\\Documents\\ChatGPTMCPProbe"',
    'if ($true) {',
    '  Write-Host "ok"',
    '}',
    '```',
  ].join('\n');

  const expected = [
    '15 seconds',
    'RUN',
    '```powershell',
    'Set-Location "D:\\Documents\\ChatGPTMCPProbe"',
    'if ($true) {',
    '  Write-Host "ok"',
    '}',
    '```',
  ].join('\n');

  assert.equal(cleanText(input), expected);
});

test('preserves interior tabs, multiple spaces, and blank lines', () => {
  const input = 'alpha\n\n\tWrite-Host    "spaced"\n  beta';
  assert.equal(cleanText(input), input);
});

test('normalizes CRLF and CR line endings without flattening lines', () => {
  assert.equal(cleanText('one\r\ntwo\rthree'), 'one\ntwo\nthree');
});

test('retains legacy chrome cleanup for simple prose', () => {
  assert.equal(
    cleanText('Thinking...\nPro thinking • \nChatGPT said:\nReady'),
    'Ready',
  );
});

test('retains legacy leading timing cleanup', () => {
  assert.equal(cleanText('15 seconds\nReady'), 'Ready');
});
