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

test('retains leading chrome cleanup for simple prose', () => {
  assert.equal(
    cleanText('Thinking...\nPro thinking • \nChatGPT said:\nReady'),
    'Ready',
  );
});

test('retains leading timing cleanup', () => {
  assert.equal(cleanText('15 seconds\nReady'), 'Ready');
});

test('peels mixed timing and chrome prefix tokens until content begins', () => {
  assert.equal(
    cleanText('15 seconds\nThinking...\nChatGPT said:\nRUN'),
    'RUN',
  );
  assert.equal(
    cleanText('Thinking...\n15 secs\nChatGPT said:\nRUN'),
    'RUN',
  );
  assert.equal(
    cleanText('Pro thinking\n3 seconds\nReasoning\n4 secs\nRUN'),
    'RUN',
  );
});

test('never rewrites chrome-like strings inside executable payload', () => {
  const payloadLines = [
    'Write-Output "ChatGPT said:"',
    'Write-Output "Thinking..."',
    'Write-Output "Answer now"',
    'Write-Output "bullet • value"',
    'Write-Output "15 seconds"',
  ];
  const input = [
    'ChatGPT said:',
    'RUN WorkingDirectory: C:\\Work TimeoutSeconds: 300',
    'powershell',
    ...payloadLines,
  ].join('\n');

  const cleaned = cleanText(input);
  for (const line of payloadLines) {
    assert.ok(
      cleaned.split('\n').includes(line),
      `cleaned response must preserve payload line exactly: ${line}\nActual:\n${cleaned}`,
    );
  }
});

test('does not remove chrome-like phrases after ordinary response content begins', () => {
  const input = 'Ready\nChatGPT said:\nThinking...\nAnswer now\nbullet • value';
  assert.equal(cleanText(input), input);
});
