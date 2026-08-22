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

test('Bridge cleaner -> Natural Protocol preserves a fenced multiline RUN end to end', () => {
  const renderedTurn = [
    'ChatGPT said:',
    'RUN WorkingDirectory: C:\\Work TimeoutSeconds: 300',
    '```powershell',
    '$x = 1',
    'Write-Output $x',
    '```',
  ].join('\n');

  const extracted = cleanText(renderedTurn);
  assert.match(extracted, /```powershell\n\$x = 1\nWrite-Output \$x\n```/);

  const directive = parseNaturalDirective(extracted, {
    defaultWorkingDirectory: 'C:\\Fallback',
    defaultTimeoutSeconds: 240,
  });

  assert.equal(directive.decision, 'RUN');
  assert.equal(directive.workingDirectory, 'C:\\Work');
  assert.equal(directive.timeoutSeconds, 300);
  assert.equal(directive.script, '$x = 1\nWrite-Output $x');
});
