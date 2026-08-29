import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve('.');
const typesModule = pathToFileURL(path.join(root, 'dist', 'types.js')).href;

function readUserDataDir(extraEnv = {}) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import { CONFIG } from ${JSON.stringify(typesModule)}; console.log(CONFIG.userDataDir);`], {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('CHATGPT_MCP_USER_DATA_DIR overrides the persistent browser directory', () => {
  const override = path.join(os.tmpdir(), 'chatgpt-mcp-portability-override');
  assert.equal(readUserDataDir({ CHATGPT_MCP_USER_DATA_DIR: override }), override);
});

test('default persistent browser directory is home-relative and never undefined', () => {
  const value = readUserDataDir({ CHATGPT_MCP_USER_DATA_DIR: '' });
  assert.notEqual(value, 'undefined/.chatgpt-mcp/user-data');
  assert.match(value, /[\\/]\.chatgpt-mcp[\\/]user-data$/);
});

test('the portability check does not create the configured directory', () => {
  const override = path.join(os.tmpdir(), `chatgpt-mcp-portability-${process.pid}`);
  fs.rmSync(override, { recursive: true, force: true });
  readUserDataDir({ CHATGPT_MCP_USER_DATA_DIR: override });
  assert.equal(fs.existsSync(override), false);
});
