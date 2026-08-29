import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve('.');
const script = path.join(root, 'tools', 'devexec-preflight.ps1');

function run(shell, localAppData) {
  return spawnSync(shell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
  ], {
    cwd: root,
    env: {
      ...process.env,
      LOCALAPPDATA: localAppData,
      DEV_EXEC_CHATGPT_CONSULT_TARGET_ALIAS: '日本語監督',
      CHATGPT_MCP_CDP_URL: 'http://127.0.0.1:9222',
    },
    encoding: 'utf8',
    windowsHide: true,
  });
}

function assertUtf8Registry(shell) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'devexec-preflight-utf8-'));
  const registryDir = path.join(base, 'DevExec');
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(path.join(registryDir, 'targets.json'), `${JSON.stringify({
    schema_version: 1,
    default_target: '日本語監督',
    targets: {
      '日本語監督': {
        transport: 'chatgpt-web',
        title: 'KNOTFIELD 日本語タイトル',
        chat_url: 'https://chatgpt.com/c/utf8-regression-123',
        conversation_id: 'utf8-regression-123',
      },
    },
  }, null, 2)}\n`, 'utf8');

  const result = run(shell, base);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  let report;
  assert.doesNotThrow(() => { report = JSON.parse(result.stdout); }, result.stdout);
  assert.equal(report.paths.target_registry.valid, true);
  // Windows PowerShell 5.1 may encode redirected stdout using the active
  // console code page; validate the semantic contract rather than the
  // presentation of the non-ASCII entry in that transport.
  assert.equal(report.paths.target_registry.entries.length, 1);
  assert.equal(report.environment.chatgpt_consultation_target_contract.present, true);
  assert.equal(report.environment.chatgpt_consultation_target_contract.canonical, true);
  assert.equal(report.environment.chatgpt_consultation_target_contract.conversation_id_match, true);
}

for (const shell of ['powershell.exe', 'pwsh.exe']) {
  const probe = spawnSync(shell, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
    encoding: 'utf8', windowsHide: true,
  });
  test(`preflight decodes UTF-8 registry under ${shell}`, { skip: probe.error?.code === 'ENOENT' }, () => {
    assertUtf8Registry(shell);
  });
}
