#!/usr/bin/env node
import { recordCodexSession, findBindingForWorkspace, defaultStateRoot } from './checkpoint-core.mjs';

export function handleSessionStart(input, env = process.env) {
  const workspace = input?.cwd;
  const sessionId = input?.session_id;
  if (!workspace || !sessionId) return { continue: true };
  const stateRoot = env.CHECKPOINT_AUTOREPORT_STATE_ROOT || defaultStateRoot(env);
  recordCodexSession({ workspace, session_id: sessionId, source: input?.source || null, model: input?.model || null, stateRoot });
  const binding = findBindingForWorkspace(workspace, { stateRoot });
  if (!binding) return { continue: true };
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `Checkpoint autoreport is active for Mission ${binding.mission_id}. Use checkpoint_save at material semantic boundaries; REPORT continues immediately, CONSULT only for material judgment boundaries.`,
    },
  };
}

async function main() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  const input = text.trim() ? JSON.parse(text) : {};
  process.stdout.write(JSON.stringify(handleSessionStart(input)) + '\n');
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href) main().catch((e) => { console.error(String(e?.stack || e)); process.exit(1); });
