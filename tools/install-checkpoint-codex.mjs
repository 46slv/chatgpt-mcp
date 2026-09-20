#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

function quote(s) { return `"${String(s).replaceAll('"','\\"')}"`; }
function hookGroup(command, kind) {
  return { hooks: [{ type:'command', command, commandWindows: command, timeout: kind === 'Stop' ? 30 : 10, statusMessage: kind === 'Stop' ? 'Checking durable checkpoint' : 'Recording checkpoint session identity' }] };
}
export function buildHookConfig({ repoRoot }) {
  const session = `node ${quote(path.join(repoRoot,'tools','checkpoint-codex-session-hook.mjs'))}`;
  const stop = `node ${quote(path.join(repoRoot,'tools','checkpoint-codex-stop-hook.mjs'))}`;
  return { session, stop };
}
function appendUnique(groups, group, command) {
  if (groups.some((g)=>Array.isArray(g?.hooks) && g.hooks.some((h)=>h?.command===command || h?.commandWindows===command))) return;
  groups.push(group);
}
export function isTemporaryRoot(repoRoot, tempRoot = os.tmpdir()) {
  const root = path.resolve(repoRoot).toLowerCase();
  const temp = path.resolve(tempRoot).toLowerCase();
  return root === temp || root.startsWith(temp + path.sep);
}
export function buildMcpRegistration({ repoRoot, nodePath = process.execPath, name = 'checkpoint_autoreport' }) {
  return { name, command: nodePath, args: [path.join(path.resolve(repoRoot), 'dist', 'index.js')] };
}
export function codexCliCommand(platform = process.platform) {
  // The Windows PowerShell/cmd shims split an executable path containing
  // spaces when they receive `mcp add -- <command> ...`.  Call the native
  // executable directly so Codex preserves the intended stdio command.
  return platform === 'win32' ? 'codex.exe' : 'codex';
}
export function ensureMcpRegistration(registration, { run = execFileSync } = {}) {
  const opts = { encoding:'utf8', stdio:['ignore','pipe','pipe'], shell: false };
  const codex = codexCliCommand();
  let current = null;
  try { current = JSON.parse(run(codex, ['mcp','get',registration.name,'--json'], opts)); } catch {}
  if (current) {
    const transport = current.transport;
    const sameType = transport?.type === 'stdio';
    const sameCommand = path.resolve(transport?.command || '') === path.resolve(registration.command);
    const sameArgs = JSON.stringify(transport?.args || []) === JSON.stringify(registration.args);
    if (!sameType || !sameCommand || !sameArgs) throw new Error(`Codex MCP ${registration.name} already exists with a different transport/command/args`);
    return { status:'ALREADY_REGISTERED', registration };
  }
  run(codex, ['mcp','add',registration.name,'--',registration.command,...registration.args], opts);
  return { status:'REGISTERED', registration };
}
export function mergeHooks(existing, commands) {
  const root = existing && typeof existing === 'object' && !Array.isArray(existing) ? structuredClone(existing) : {};
  root.description ||= 'User-level Codex hooks.';
  root.hooks ||= {};
  root.hooks.SessionStart ||= [];
  root.hooks.Stop ||= [];
  appendUnique(root.hooks.SessionStart, hookGroup(commands.session,'SessionStart'), commands.session);
  appendUnique(root.hooks.Stop, hookGroup(commands.stop,'Stop'), commands.stop);
  return root;
}
export function install({ repoRoot, home = os.homedir(), dryRun = false, registerMcp = false, mcpRunner = execFileSync } = {}) {
  const root = path.resolve(repoRoot || path.join(path.dirname(fileURLToPath(import.meta.url)),'..'));
  const sourceSkill = path.join(root,'.agents','skills','checkpoint-autoreport');
  if (!fs.existsSync(path.join(sourceSkill,'SKILL.md'))) throw new Error(`skill source missing: ${sourceSkill}`);
  const mcpRegistration = buildMcpRegistration({repoRoot:root});
  const codexDir = path.join(home,'.codex'); const hooksFile = path.join(codexDir,'hooks.json');
  const skillDir = path.join(home,'.agents','skills','checkpoint-autoreport');
  const existing = fs.existsSync(hooksFile) ? JSON.parse(fs.readFileSync(hooksFile,'utf8')) : {};
  const commands = buildHookConfig({repoRoot:root}); const merged = mergeHooks(existing,commands);
  const plan = { repoRoot:root, hooksFile, skillDir, hooks:merged, mcpRegistration, temporaryRoot:isTemporaryRoot(root) };
  if (dryRun) return plan;
  if (isTemporaryRoot(root)) throw new Error('Refusing persistent Codex install from an OS temporary checkout; use a durable checkout path.');
  if (!fs.existsSync(mcpRegistration.args[0])) throw new Error(`built MCP entrypoint missing: ${mcpRegistration.args[0]}; run npm run build first`);
  fs.mkdirSync(codexDir,{recursive:true});
  if (fs.existsSync(hooksFile)) fs.copyFileSync(hooksFile, `${hooksFile}.checkpoint-autoreport.bak`);
  fs.writeFileSync(hooksFile, JSON.stringify(merged,null,2)+'\n','utf8');
  fs.mkdirSync(path.dirname(skillDir),{recursive:true});
  if (fs.existsSync(skillDir)) {
    const stat=fs.lstatSync(skillDir);
    if (stat.isSymbolicLink()) fs.unlinkSync(skillDir); else fs.rmSync(skillDir,{recursive:true,force:true});
  }
  try { fs.symlinkSync(sourceSkill,skillDir,process.platform==='win32'?'junction':'dir'); }
  catch { fs.cpSync(sourceSkill,skillDir,{recursive:true}); }
  const mcp = registerMcp ? ensureMcpRegistration(mcpRegistration,{run:mcpRunner}) : { status:'NOT_REQUESTED', registration:mcpRegistration };
  return { ...plan, mcp };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\','/')}`).href) {
  const dryRun=process.argv.includes('--dry-run');
  const registerMcp=process.argv.includes('--register-mcp');
  const result=install({dryRun,registerMcp});
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
