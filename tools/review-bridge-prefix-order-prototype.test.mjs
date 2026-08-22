import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanLeadingUiPrefix } from './review-bridge-prefix-order-prototype.mjs';

const body = [
  'RUN WorkingDirectory: C:\\Work TimeoutSeconds: 300',
  'powershell',
  'Write-Output "ok"',
].join('\n');

test('prototype removes timing then chrome before RUN', () => {
  assert.equal(
    cleanLeadingUiPrefix(['15 seconds', 'Thinking...', 'ChatGPT said:', body].join('\n')),
    body,
  );
});

test('prototype removes chrome then timing then chrome before RUN', () => {
  assert.equal(
    cleanLeadingUiPrefix(['Thinking...', '15 secs', 'ChatGPT said:', body].join('\n')),
    body,
  );
});

test('prototype removes repeated mixed prefix tokens', () => {
  assert.equal(
    cleanLeadingUiPrefix(['Pro thinking', '3 seconds', 'Reasoning', '4 secs', body].join('\n')),
    body,
  );
});

test('prototype preserves timing and chrome-like strings after RUN begins', () => {
  const payload = [
    'RUN WorkingDirectory: C:\\Work TimeoutSeconds: 300',
    'powershell',
    'Write-Output "15 seconds"',
    'Write-Output "Thinking..."',
    'Write-Output "ChatGPT said:"',
  ].join('\n');
  assert.equal(cleanLeadingUiPrefix(payload), payload);
});
