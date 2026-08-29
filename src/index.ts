#!/usr/bin/env node
/**
 * chatgpt-mcp — MCP server for ChatGPT web UI automation via Playwright
 *
 * Provides 5 tools: chatgpt_ask, chatgpt_reply, chatgpt_upload,
 * chatgpt_select_project, chatgpt_new_chat
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  blockingAsk,
  blockingReply,
  uploadFiles,
  selectProject,
  newConversation,
} from './chatgpt.js';
import { closeBrowser } from './browser.js';

const server = new McpServer({
  name: 'chatgpt-mcp',
  version: '1.0.0',
});

// =============================================================================
// Tool: chatgpt_ask
// =============================================================================
server.registerTool(
  'chatgpt_ask',
  {
    title: 'Ask ChatGPT (Blocking)',
    description: `Send a prompt to ChatGPT and wait for the complete response.

Handles the full request/response cycle:
1. Auto-starts browser session on first call
2. Optionally switches project and model
3. Sends prompt and polls with Fibonacci backoff
4. Returns complete response (supports GPT-5.2 Pro 20+ min thinking)

Returns: { response, elapsed_seconds, model, chat_id, poll_count }`,
    inputSchema: z.object({
      prompt: z.string().min(1).describe('The prompt to send to ChatGPT'),
      model: z.string().optional().describe('Model/mode to select (e.g. "Pro", "Thinking", "Instant")'),
      project: z.string().optional().describe('Project name to switch to before sending'),
      timeout_minutes: z.number().min(1).max(120).default(60).describe('Max wait time in minutes (default: 60)'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ prompt, model, project, timeout_minutes }) => {
    const result = await blockingAsk(prompt, model, project, timeout_minutes);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(result, null, 2),
      }],
    };
  },
);

// =============================================================================
// Tool: chatgpt_reply
// =============================================================================
server.registerTool(
  'chatgpt_reply',
  {
    title: 'Reply in Current Chat (Blocking)',
    description: `Send a follow-up prompt in the current conversation and wait for the response.

Same blocking behavior as chatgpt_ask but does not switch project or model.
Use after chatgpt_ask to continue the conversation.

Returns: { response, elapsed_seconds, model, chat_id, poll_count }`,
    inputSchema: z.object({
      prompt: z.string().min(1).describe('The follow-up prompt to send'),
      timeout_minutes: z.number().min(1).max(120).default(60).describe('Max wait time in minutes (default: 60)'),
      target_url: z.string().optional().describe('Runner-owned exact https://chatgpt.com/c/<safe-id> or https://chatgpt.com/g/<safe-slug>/c/<safe-id> target; omit for legacy current-chat behavior'),
      expected_conversation_id: z.string().optional().describe('Runner-owned conversation id; must match target_url when supplied'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ prompt, timeout_minutes, target_url, expected_conversation_id }) => {
    const result = await blockingReply(prompt, timeout_minutes, { target_url, expected_conversation_id });
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(result, null, 2),
      }],
    };
  },
);

// =============================================================================
// Tool: chatgpt_upload
// =============================================================================
server.registerTool(
  'chatgpt_upload',
  {
    title: 'Upload Files to ChatGPT (Blocking)',
    description: `Upload one or more files to ChatGPT, optionally with a prompt, and wait for response.

Clicks the attach button, selects files via file chooser, sends, and polls.

Returns: { response, elapsed_seconds, model, chat_id, poll_count }`,
    inputSchema: z.object({
      file_paths: z.array(z.string()).min(1).describe('Absolute paths to files to upload'),
      prompt: z.string().optional().describe('Optional prompt to send with the files'),
      timeout_minutes: z.number().min(1).max(120).default(60).describe('Max wait time in minutes (default: 60)'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ file_paths, prompt, timeout_minutes }) => {
    const result = await uploadFiles(file_paths, prompt, timeout_minutes);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(result, null, 2),
      }],
    };
  },
);

// =============================================================================
// Tool: chatgpt_select_project
// =============================================================================
server.registerTool(
  'chatgpt_select_project',
  {
    title: 'Select ChatGPT Project',
    description: `Select a project from the ChatGPT sidebar by name.

Finds project links (matching /g/g-p-* URLs) and navigates to the project.
Subsequent conversations will stay within this project context.

Returns: { success, message }`,
    inputSchema: z.object({
      project: z.string().min(1).describe('Project name to select'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ project }) => {
    const result = await selectProject(project);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(result, null, 2),
      }],
    };
  },
);

// =============================================================================
// Tool: chatgpt_new_chat
// =============================================================================
server.registerTool(
  'chatgpt_new_chat',
  {
    title: 'Start New ChatGPT Conversation',
    description: `Start a fresh conversation in ChatGPT.

Navigates to the project URL (if in a project) or ChatGPT home.
Resets conversation state.

Returns: { success, message }`,
    inputSchema: z.object({}),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async () => {
    const result = await newConversation();
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(result, null, 2),
      }],
    };
  },
);

// =============================================================================
// Shutdown handler
// =============================================================================

async function shutdown() {
  console.error('Shutting down chatgpt-mcp...');
  await closeBrowser();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// =============================================================================
// Main
// =============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('chatgpt-mcp server running on stdio');
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
