import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { resolveWsDispatchConfig } from './ws-dispatch-config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(here, '..');
const runtimeTools = Object.freeze([
  'checkpoint-core.mjs',
  'ws-dispatch-checkpoint-adapter.mjs',
  'ws-dispatch-checkpoint-delivery.mjs',
  'ws-dispatch-cli.mjs',
  'ws-dispatch-config.mjs',
  'ws-dispatch-core.mjs',
  'ws-dispatch-install.mjs',
  'ws-dispatch-opencode.mjs',
  'ws-dispatch-server.mjs',
  'ws-dispatch-task.ps1',
]);

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const handle = fs.openSync(temp, 'wx');
  try {
    fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temp, file);
}

function sourceRevision(root, execFile = execFileSync) {
  const revision = execFile('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const dirty = execFile('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' }).trim();
  if (dirty) throw new Error('canonical runtime install requires a clean exact Git candidate');
  return revision;
}

function copyRuntimeSource(from, to) {
  fs.mkdirSync(path.join(to, 'tools'), { recursive: true });
  for (const name of ['package.json', 'package-lock.json']) {
    const source = path.join(from, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(to, name));
  }
  const dist = path.join(from, 'dist');
  if (!fs.existsSync(path.join(dist, 'chatgpt.js'))) {
    throw new Error('built dist/chatgpt.js is required; run npm run build before task-install');
  }
  fs.cpSync(dist, path.join(to, 'dist'), { recursive: true, errorOnExist: true });
  for (const name of runtimeTools) {
    fs.copyFileSync(path.join(from, 'tools', name), path.join(to, 'tools', name));
  }
}

export function resolveNpmInvocation({
  platform = process.platform,
  nodePath = process.execPath,
  existsSync = fs.existsSync,
} = {}) {
  if (platform !== 'win32') return Object.freeze({ command: 'npm', args_prefix: Object.freeze([]) });
  const npmCli = path.join(path.dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(npmCli)) throw new Error(`npm-cli.js was not found beside the active Node runtime: ${npmCli}`);
  return Object.freeze({ command: nodePath, args_prefix: Object.freeze([npmCli]) });
}

function powershellJson(args, { execFile = execFileSync } = {}) {
  const output = execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'ws-dispatch-task.ps1'), ...args],
    { encoding: 'utf8', windowsHide: true },
  );
  return JSON.parse(output.trim());
}

export function readWsDispatchInstallation({ config = resolveWsDispatchConfig() } = {}) {
  if (!fs.existsSync(config.installation_file)) return null;
  return JSON.parse(fs.readFileSync(config.installation_file, 'utf8'));
}

export function scheduledTaskStatus({ config = resolveWsDispatchConfig(), execFile = execFileSync } = {}) {
  return powershellJson(['-Action', 'Status', '-TaskName', config.task_name], { execFile });
}

export function installScheduledDispatcher({
  config = resolveWsDispatchConfig(),
  source = sourceRoot,
  execFile = execFileSync,
  now = () => new Date().toISOString(),
} = {}) {
  const revision = sourceRevision(source, execFile);
  if (!/^[0-9a-f]{40}$/u.test(revision)) throw new Error('source revision is invalid');
  fs.mkdirSync(config.releases_root, { recursive: true });
  const release = path.join(config.releases_root, revision);
  if (!fs.existsSync(release)) {
    const stage = path.join(config.releases_root, `.stage-${revision}-${process.pid}`);
    if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: false });
    try {
      copyRuntimeSource(source, stage);
      const npm = resolveNpmInvocation();
      execFile(
        npm.command,
        [...npm.args_prefix, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
        { cwd: stage, stdio: 'pipe', encoding: 'utf8', windowsHide: true },
      );
      fs.renameSync(stage, release);
    } catch (error) {
      fs.rmSync(stage, { recursive: true, force: true });
      throw error;
    }
  }
  const cliPath = path.join(release, 'tools', 'ws-dispatch-cli.mjs');
  const task = powershellJson([
    '-Action', 'Install',
    '-TaskName', config.task_name,
    '-NodePath', process.execPath,
    '-CliPath', cliPath,
    '-WorkingDirectory', release,
  ], { execFile });
  const installation = {
    protocol: 'ws-dispatch.installation',
    schema_version: 1,
    source_revision: revision,
    source_root: path.resolve(source),
    runtime_path: release,
    cli_path: cliPath,
    node_path: process.execPath,
    dispatch_root: config.root,
    checkpoint_state_root: config.checkpoint_state_root,
    task_name: config.task_name,
    installed_at: now(),
  };
  atomicJson(config.installation_file, installation);
  return Object.freeze({ installation, task });
}

export function uninstallScheduledDispatcher({ config = resolveWsDispatchConfig(), execFile = execFileSync } = {}) {
  const task = powershellJson(['-Action', 'Uninstall', '-TaskName', config.task_name], { execFile });
  return Object.freeze({
    task,
    preserved_dispatch_root: config.root,
    preserved_installation: readWsDispatchInstallation({ config }),
  });
}
