#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
export function install({ repoRoot, home = os.homedir(), dryRun = false } = {}) {
  const root = path.resolve(repoRoot || path.join(path.dirname(fileURLToPath(import.meta.url)),'..'));
  const sourceSkill = path.join(root,'.agents','skills','checkpoint-autoreport');
  if (!fs.existsSync(path.join(sourceSkill,'SKILL.md'))) throw new Error(`skill source missing: ${sourceSkill}`);
  const codexDir = path.join(home,'.codex'); const hooksFile = path.join(codexDir,'hooks.json');
  const skillDir = path.join(home,'.agents','skills','checkpoint-autoreport');
  const existing = fs.existsSync(hooksFile) ? JSON.parse(fs.readFileSync(hooksFile,'utf8')) : {};
  const commands = buildHookConfig({repoRoot:root}); const merged = mergeHooks(existing,commands);
  const plan = { repoRoot:root, hooksFile, skillDir, hooks:merged };
  if (dryRun) return plan;
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
  return plan;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\','/')}`).href) {
  const dryRun=process.argv.includes('--dry-run');
  const result=install({dryRun});
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
