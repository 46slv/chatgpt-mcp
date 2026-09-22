import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { resolveNpmInvocation } from './ws-dispatch-install.mjs';

test('Windows runtime install invokes npm-cli.js through node without a cmd shell shim', () => {
  const nodePath = 'C:\\Program Files\\nodejs\\node.exe';
  const invocation = resolveNpmInvocation({ platform: 'win32', nodePath, existsSync: () => true });
  assert.equal(invocation.command, nodePath);
  assert.deepEqual(invocation.args_prefix, [path.join(path.dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js')]);
  assert.throws(
    () => resolveNpmInvocation({ platform: 'win32', nodePath, existsSync: () => false }),
    /npm-cli\.js was not found/,
  );
});

test('non-Windows runtime install uses the native npm executable directly', () => {
  assert.deepEqual(resolveNpmInvocation({ platform: 'linux' }), { command: 'npm', args_prefix: [] });
});
