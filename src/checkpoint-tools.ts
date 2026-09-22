import { z } from 'zod';
import { blockingReply, sendOnlyReply } from './chatgpt.js';

const CORE_MODULE = '../tools/checkpoint-core.mjs';
const dispatchChains = new Map<string, Promise<unknown>>();

async function core(): Promise<any> {
  return import(CORE_MODULE);
}

function textEnvelope(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

async function dispatchOne(event: any): Promise<any> {
  const c = await core();
  return c.dispatchCheckpoint({
    event,
    send: async ({ packet, target, event: current }: any) => current.mode === 'CONSULT'
      ? blockingReply(
          packet,
          60,
          { target_url: target.chat_url, expected_conversation_id: target.conversation_id },
        )
      : sendOnlyReply(
          packet,
          { target_url: target.chat_url, expected_conversation_id: target.conversation_id },
        ),
  });
}

function enqueueEvent(event: any): Promise<any> {
  const key = event.report_target.conversation_id;
  const previous = dispatchChains.get(key) || Promise.resolve();
  const current = previous.catch(() => undefined).then(() => dispatchOne(event));
  dispatchChains.set(key, current);
  current.finally(() => {
    if (dispatchChains.get(key) === current) dispatchChains.delete(key);
  }).catch(() => undefined);
  return current;
}

async function recoverPending(workspace: string, limit = 8) {
  const c = await core();
  const pending = c.pendingCheckpoints({ workspace }).slice(0, limit);
  for (const event of pending) {
    if (event.mode === 'REPORT') enqueueEvent(event).catch(() => undefined);
  }
  return pending.length;
}

export function registerCheckpointTools(server: any) {
  server.registerTool(
    'checkpoint_bind',
    {
      title: 'Bind Checkpoint Autoreport Mission',
      description: 'Bind one workspace to one durable checkpoint Mission and one exact ChatGPT conversation target. Call once before checkpoint_save. Rebinding to a different Mission/target fails closed unless replace=true.',
      inputSchema: z.object({
        workspace: z.string().min(1),
        mission_id: z.string().min(1),
        goal: z.string().optional(),
        target_alias: z.string().optional(),
        target_url: z.string().optional(),
        expected_conversation_id: z.string().optional(),
        replace: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input: any) => {
      const c = await core();
      const binding = c.bindWorkspace(input);
      const pending_reports_seen = await recoverPending(binding.workspace);
      return textEnvelope({ binding, pending_reports_seen });
    },
  );

  server.registerTool(
    'checkpoint_save',
    {
      title: 'Save Durable Mission Checkpoint',
      description: 'Save one material checkpoint as an immutable event/outbox. REPORT queues exact-bound ChatGPT reporting in the background and returns immediately. CONSULT waits for the correlated ChatGPT advisory response.',
      inputSchema: z.object({
        workspace: z.string().min(1),
        next: z.string().min(1),
        approach: z.string().min(1),
        done_for_next: z.string().optional(),
        mode: z.enum(['REPORT', 'CONSULT']).default('REPORT'),
        question: z.string().optional(),
        evidence_refs: z.array(z.string()).max(32).default([]),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input: any) => {
      const c = await core();
      const event = c.saveCheckpoint(input);
      if (event.mode === 'REPORT') {
        enqueueEvent(event).catch(() => undefined);
        return textEnvelope({ checkpoint: event, dispatch: 'QUEUED_BACKGROUND' });
      }
      const dispatch = await enqueueEvent(event);
      return textEnvelope({ checkpoint: event, dispatch });
    },
  );

  server.registerTool(
    'checkpoint_status',
    {
      title: 'Inspect Checkpoint Autoreport State',
      description: 'Inspect the bound Mission, latest checkpoint, pending reports, claims, and latest receipt for a workspace. Read-only.',
      inputSchema: z.object({ workspace: z.string().min(1) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ workspace }: any) => {
      const c = await core();
      return textEnvelope(c.checkpointStatus({ workspace }));
    },
  );

  server.registerTool(
    'checkpoint_dispatch',
    {
      title: 'Drain Pending Checkpoint Reports',
      description: 'Explicitly drain unclaimed pending checkpoint reports for a workspace. Confirmed delivery, DELIVERY_UNKNOWN, and existing claims are not blindly retried.',
      inputSchema: z.object({ workspace: z.string().min(1), max_events: z.number().int().min(1).max(32).default(8) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace, max_events }: any) => {
      const c = await core();
      const pending = c.pendingCheckpoints({ workspace }).slice(0, max_events);
      const results = [];
      for (const event of pending) results.push(await enqueueEvent(event));
      return textEnvelope({ attempted: pending.length, results, status: c.checkpointStatus({ workspace }) });
    },
  );
}
