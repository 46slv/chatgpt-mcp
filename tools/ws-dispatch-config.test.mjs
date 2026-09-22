import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { resolveWsDispatchConfig, WS_DISPATCH_TASK_NAME } from './ws-dispatch-config.mjs';

test('machine-local defaults reuse the ChatGPTMCPProbe owner and one WS Dispatch identity', () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-dispatch-config-'));
  const config = resolveWsDispatchConfig({ env: { LOCALAPPDATA: local } });
  assert.equal(config.root, path.join(local, 'ChatGPTMCPProbe', 'ws-dispatch-v1'));
  assert.equal(config.checkpoint_state_root, path.join(local, 'ChatGPTMCPProbe', 'checkpoint-autoreport-v1'));
  assert.equal(config.task_name, WS_DISPATCH_TASK_NAME);
  assert.equal(config.installation_file, path.join(config.root, 'runtime', 'installation.json'));
});

test('Scheduled Task script parses without PowerShell syntax errors', () => {
  const script = path.join(import.meta.dirname, 'ws-dispatch-task.ps1');
  const quotedScript = script.replaceAll("'", "''");
  const command = [
    '$tokens=$null',
    '$errors=$null',
    `[System.Management.Automation.Language.Parser]::ParseFile('${quotedScript}',[ref]$tokens,[ref]$errors) | Out-Null`,
    'if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }',
  ].join('; ');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'pipe' });
});
