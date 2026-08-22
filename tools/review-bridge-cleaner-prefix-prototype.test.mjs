import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanBridgeResponseTextPrefixOnly } from './review-bridge-cleaner-prefix-prototype.mjs';

test('removes stacked leading UI chrome but preserves directive payload verbatim', () => {
  const input = [
    'Thinking...',
    'Pro thinking • ',
    'ChatGPT said:',
    'RUN WorkingDirectory: C:\\Work TimeoutSeconds: 300',
    'powershell',
    'Write-Output "ChatGPT said:"',
    'Write-Output "Thinking..."',
    'Write-Output "Answer now"',
    'Write-Output "bullet • value"',
  ].join('\r\n');

  assert.equal(
    cleanBridgeResponseTextPrefixOnly(input),
    [
      'RUN WorkingDirectory: C:\\Work TimeoutSeconds: 300',
      'powershell',
      'Write-Output "ChatGPT said:"',
      'Write-Output "Thinking..."',
      'Write-Output "Answer now"',
      'Write-Output "bullet • value"',
    ].join('\n'),
  );
});

test('does not strip chrome-looking text inside ordinary response content', () => {
  const input = 'Explanation\nChatGPT said:\nThinking...\nAnswer now';
  assert.equal(cleanBridgeResponseTextPrefixOnly(input), input);
});

test('keeps legacy leading timing cleanup without touching later numbers', () => {
  assert.equal(
    cleanBridgeResponseTextPrefixOnly('15 seconds\nReady in 15 seconds'),
    'Ready in 15 seconds',
  );
});

test('normalizes CRLF/CR to LF and preserves interior whitespace', () => {
  assert.equal(
    cleanBridgeResponseTextPrefixOnly('ChatGPT said:\r\nalpha\r\tbeta    gamma'),
    'alpha\n\tbeta    gamma',
  );
});
