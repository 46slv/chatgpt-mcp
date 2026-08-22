import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNaturalDirective, assertSafeFlatBridgePowerShell } from './dev-exec-natural-protocol.mjs';

const opts = { defaultWorkingDirectory: 'C:\\Work', defaultTimeoutSeconds: 240 };

test('flat Bridge fallback accepts a simple single statement', () => {
  const result = parseNaturalDirective('RUN PowerShell Write-Output "ok"', opts);
  assert.equal(result.decision, 'RUN');
  assert.equal(result.script, 'Write-Output "ok"');
});

test('flat Bridge fallback rejects semicolon-flattened multi-statement script', () => {
  assert.throws(
    () => parseNaturalDirective('RUN PowerShell $x = 1; Write-Output $x', opts),
    /flat Bridge fallback rejected ambiguous PowerShell/,
  );
});

test('flat Bridge fallback rejects block-shaped flattened script', () => {
  assert.throws(
    () => parseNaturalDirective('RUN PowerShell if ($true) { Write-Output "ok" }', opts),
    /flat Bridge fallback rejected ambiguous PowerShell/,
  );
});

test('flat Bridge fallback rejects comments that can swallow flattened remainder', () => {
  assert.throws(
    () => assertSafeFlatBridgePowerShell('Write-Output "a" # comment Write-Output "b"'),
    /comment marker/,
  );
});

test('flat Bridge fallback rejects here-strings and backtick continuations', () => {
  assert.throws(() => assertSafeFlatBridgePowerShell('$x = @" text "@'), /here-string marker/);
  assert.throws(() => assertSafeFlatBridgePowerShell('Write-Output ` value'), /line-continuation marker/);
});

test('fenced multiline PowerShell remains accepted and preserves line structure', () => {
  const result = parseNaturalDirective(
    'RUN WorkingDirectory: C:\\Work TimeoutSeconds: 300\n```powershell\n$x = 1\nWrite-Output $x\n```',
    opts,
  );
  assert.equal(result.decision, 'RUN');
  assert.equal(result.timeoutSeconds, 300);
  assert.equal(result.script, '$x = 1\nWrite-Output $x');
});
