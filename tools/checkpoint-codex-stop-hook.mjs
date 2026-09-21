#!/usr/bin/env node
import { evaluateStopGuard, defaultStateRoot } from './checkpoint-core.mjs';

export function handleStop(input, env = process.env) {
  if (!input?.cwd || !input?.session_id) return { continue: true };
  const stateRoot = env.CHECKPOINT_AUTOREPORT_STATE_ROOT || defaultStateRoot(env);
  return evaluateStopGuard({ workspace: input.cwd, session_id: input.session_id, stop_hook_active: Boolean(input.stop_hook_active), stateRoot });
}

async function main() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  const input = text.trim() ? JSON.parse(text) : {};
  process.stdout.write(JSON.stringify(handleStop(input)) + '\n');
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href) main().catch((e) => { console.error(String(e?.stack || e)); process.exit(1); });
