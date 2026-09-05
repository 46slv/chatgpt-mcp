// Local stage sidecar for ChatGPT reply diagnostics.
//
// The MCP result schema stays strict: stage and exception detail are mirrored
// here (and on stderr) instead of being added to AskResult. Override the file
// location with CHATGPT_MCP_STAGE_SIDECAR; the default is the OS temp
// directory. Writes are best-effort and never throw into the send path.
// Prompt text is never logged.

import { appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function defaultStageSidecarPath(): string {
  return path.join(os.tmpdir(), 'chatgpt-web-probe-reply-stages.jsonl');
}

export function stageSidecarPath(): string {
  const override = process.env.CHATGPT_MCP_STAGE_SIDECAR;
  if (typeof override === 'string' && override.trim() !== '') return override;
  return defaultStageSidecarPath();
}

export function appendStageEvent(event: Record<string, unknown>, filePath?: string): void {
  try {
    const target = filePath ?? stageSidecarPath();
    appendFileSync(target, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n', 'utf8');
  } catch {
    // Diagnostics must never break the send path.
  }
}
