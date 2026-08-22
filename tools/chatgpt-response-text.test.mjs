import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanExtractedResponseText } from '../dist/response-text.js';

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

  assert.equal(cleanExtractedResponseText(input), expected);
});

test('preserves interior tabs, multiple spaces, and blank lines', () => {
  const input = 'alpha\n\n\tWrite-Host    "spaced"\n  beta';
  assert.equal(cleanExtractedResponseText(input), input);
});

test('normalizes CRLF/CR line endings without flattening lines', () => {
  assert.equal(
    cleanExtractedResponseText('one\r\ntwo\rthree'),
    'one\ntwo\nthree',
  );
});

test('retains legacy chrome cleanup for simple prose', () => {
  assert.equal(
    cleanExtractedResponseText('Thinking...\nPro thinking • \nChatGPT said:\nReady'),
    'Ready',
  );
});
