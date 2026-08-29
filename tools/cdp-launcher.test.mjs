import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve('.');
const launcher = path.join(root, 'tools', 'start-chatgpt-cdp.ps1');
const powershell = process.env.PWSH || process.env.POWERSHELL || 'powershell';

function runLauncher(args, env = {}) {
  const result = spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher, ...args,
  ], { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8' });
  let report = null;
  try { report = JSON.parse(result.stdout); } catch { /* expected for parser/launch errors only */ }
  return { ...result, report };
}

test('explicit Chrome path wins and plan mode constructs safe CDP arguments without launching', () => {
  const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'devexec-cdp-test-')), 'chrome.exe');
  fs.writeFileSync(fake, 'placeholder');
  const profile = path.join(os.tmpdir(), 'ChatGPTMCP profile with spaces');
  const result = runLauncher([
    '-Plan', '-ChromePath', fake, '-CdpPort', '19333', '-UserDataDir', profile,
    '-ChatUrl', 'https://chatgpt.com/c/example',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.action, 'would_launch');
  assert.equal(result.report.selected_browser.source, 'explicit');
  assert.equal(result.report.selected_browser.path, fake);
  assert.deepEqual(result.report.arguments, [
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=19333',
    `--user-data-dir=${profile}`,
    'https://chatgpt.com/c/example',
  ]);
  assert.equal(result.report.process_id, null);
});

test('CHATGPT_MCP_USER_DATA_DIR is used when no profile parameter is supplied', () => {
  const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'devexec-cdp-test-')), 'chrome.exe');
  fs.writeFileSync(fake, 'placeholder');
  const profile = path.join(os.tmpdir(), 'devexec-env-profile');
  const result = runLauncher(['-Plan', '-ChromePath', fake, '-ChatUrl', 'https://chatgpt.com'], {
    CHATGPT_MCP_USER_DATA_DIR: profile,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.user_data_dir, profile);
  assert.equal(fs.existsSync(profile), false, 'plan mode must not create the profile');
});
