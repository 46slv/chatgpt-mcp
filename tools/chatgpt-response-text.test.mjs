import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const chatgptSource = readFileSync(
  new URL('../src/chatgpt.ts', import.meta.url),
  'utf8',
);

const cleanResponseTextMatch = chatgptSource.match(
  /export function cleanResponseText\(value: unknown\): string \{\n([\s\S]*?)\n\}/,
);

assert.ok(
  cleanResponseTextMatch,
  'cleanResponseText implementation must remain discoverable by the regression test',
);

const cleanResponseText = new Function(
  `return (value) => {\n${cleanResponseTextMatch[1]}\n};`,
)();

test('source does not collapse all response whitespace into spaces', () => {
  assert.doesNotMatch(
    chatgptSource,
    /cleaned\s*=\s*cleaned\.replace\(\/\\s\+\/g, ['"] ['"]\)\.trim\(\)/,
  );
});

test('preserves fenced multiline PowerShell structure and indentation', () => {
  const input = [
    'ChatGPT said:',
    'RUN',
    '```powershell',
    'Set-Location "D:\\Documents\\ChatGPTMCPProbe"',
    'if ($true) {',
    '  Write-Host "ok"',
    '}',
    '```',
  ].join('\n');

  const expected = [
    'RUN',
    '```powershell',
    'Set-Location "D:\\Documents\\ChatGPTMCPProbe"',
    'if ($true) {',
    '  Write-Host "ok"',
    '}',
    '```',
  ].join('\n');

  assert.equal(cleanResponseText(input), expected);
});

test('preserves interior tabs, repeated spaces, and blank lines', () => {
  const input = 'alpha\n\n\tWrite-Host    "spaced"\n  beta';
  assert.equal(cleanResponseText(input), input);
});

test('normalizes CRLF and CR line endings without flattening lines', () => {
  assert.equal(cleanResponseText('one\r\ntwo\rthree'), 'one\ntwo\nthree');
});

test('retains chrome cleanup for simple prose', () => {
  assert.equal(cleanResponseText('ChatGPT said: hello'), 'hello');
});

test('retains leading timing cleanup', () => {
  assert.equal(cleanResponseText('15 seconds\nReady'), 'Ready');
});
