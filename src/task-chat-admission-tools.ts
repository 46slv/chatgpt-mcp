import { z } from 'zod';

import {
  prepareTaskChatAdmission,
  sendTaskChatAdmissionSeed,
} from './chatgpt.js';

const CORE_MODULE = '../tools/devexec-task-chat-admission.mjs';

async function core(): Promise<any> {
  return import(CORE_MODULE);
}

function textEnvelope(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

/** Register the durable Task → ChatGPT admission primitives. */
export function registerTaskChatAdmissionTools(server: any) {
  server.registerTool(
    'task_chat_admit',
    {
      title: 'Admit Durable Task ChatGPT Conversation',
      description: 'Create or reuse exactly one fresh ChatGPT conversation for the supplied durable mission/task identity. The URL is provisioned by the bridge and is never supplied by the caller; replay after BOUND performs zero sends.',
      inputSchema: z.object({
        mission_id: z.string().min(1).describe('Durable mission identity'),
        task_id: z.string().min(1).describe('Durable task identity'),
        admission_root: z.string().optional().describe('Optional absolute runtime admission-state root'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ mission_id, task_id, admission_root }: { mission_id: string; task_id: string; admission_root?: string }) => {
      const c = await core();
      const result = await c.admitTaskChat({
        mission_id,
        task_id,
        admission_root,
        prepare: () => prepareTaskChatAdmission(),
        send: ({ seed }: { seed: string }) => sendTaskChatAdmissionSeed(seed),
      });
      return textEnvelope({
        operation: 'task_chat_admit',
        phase: result.state.phase,
        admission_id: result.admission_id,
        created: result.created,
        replay: result.replay,
        seed_sent: result.seed_sent,
        binding: result.binding,
        acknowledgement: result.state.acknowledgement,
        failure: result.state.failure,
        file: result.file,
      });
    },
  );

  server.registerTool(
    'task_chat_admission_status',
    {
      title: 'Inspect Durable Task ChatGPT Admission',
      description: 'Read the durable automatic Task-chat admission state. This operation never consults browser focus, current chat, registry defaults, project state, or recent-chat heuristics.',
      inputSchema: z.object({
        mission_id: z.string().min(1).describe('Durable mission identity'),
        task_id: z.string().min(1).describe('Durable task identity'),
        admission_root: z.string().optional().describe('Optional absolute runtime admission-state root'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ mission_id, task_id, admission_root }: { mission_id: string; task_id: string; admission_root?: string }) => {
      const c = await core();
      return textEnvelope(c.taskChatAdmissionStatus({ mission_id, task_id, admission_root }));
    },
  );
}
