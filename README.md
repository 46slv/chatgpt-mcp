# chatgpt-mcp

MCP server that gives ChatGPT's web UI the same `ask(prompt) → response` interface as CLI-based AI tools (Codex, Gemini CLI, etc.). Built with Playwright for browser automation.

## Why this exists

This is part of a multi-model orchestration setup where Claude Code acts as the top-level AI orchestrator, dispatching tasks to the best model for the job:

- **Codex** (OpenAI) — available via CLI (`codex mcp-server`)
- **Gemini** — available via CLI (`gemini-mcp-tool`)
- **Claude** — the orchestrator itself
- **GPT-5.2 Pro** — only available through ChatGPT's web UI (not API on subscription plans)

GPT-5.2 Pro is the most powerful model available for many tasks but lacks a CLI/API interface. This MCP server bridges that gap by automating the ChatGPT web UI via Playwright, giving it the same ergonomic blocking `ask → response` pattern as the other models.

### Use cases
- Dispatching complex reasoning tasks to GPT-5.2 Pro from Claude Code
- AI round-table discussions where Claude Code facilitates debate between all models
- File analysis by uploading documents to ChatGPT
- Project-scoped conversations using ChatGPT's Projects feature

## Architecture

```
Claude Code (orchestrator)
    ├── Codex CLI    → mcp-server (stdio)
    ├── Gemini CLI   → mcp-tool (stdio)
    ├── Claude       → native
    └── ChatGPT      → chatgpt-mcp (this project)
                         └── Playwright → Chromium → chatgpt.com

DevExec autonomous consultation (explicit opt-in only)
    Codex goal → local planner → fixed `chatgpt_reply` target → untrusted evidence → planner/typed LocalExecutor
```

The server launches a persistent Chromium browser on first use, maintains login cookies across sessions, and uses multi-strategy DOM scraping to extract responses reliably despite ChatGPT's frequently-changing UI.

## Tools

| Tool | Description |
|------|-------------|
| `chatgpt_ask` | Send prompt, optionally switch model/project, poll until complete, return response |
| `chatgpt_reply` | Follow-up in current conversation; optionally target an exact prepared conversation with `target_url` + `expected_conversation_id` |
| `chatgpt_upload` | Upload files + optional prompt, poll for response |
| `chatgpt_select_project` | Navigate to a ChatGPT Project by name |
| `chatgpt_new_chat` | Start fresh conversation (stays in project if set) |

All tools are **blocking** — they return only when the response is ready (or timeout). This matches the ergonomics of Codex and Gemini MCPs.

DevExec's local worker can optionally ask one fixed ChatGPT conversation for bounded ordinary-text guidance. Set `DEV_EXEC_CHATGPT_CONSULT_ENABLED=1` and `DEV_EXEC_CHATGPT_CONSULT_TARGET_ALIAS=<alias>` in the invoking process; the default is disabled. Optional `DEV_EXEC_CHATGPT_CONSULT_MAX_REQUESTS`, `DEV_EXEC_CHATGPT_CONSULT_MAX_CHARS`, `DEV_EXEC_CHATGPT_CONSULT_EVIDENCE_CHARS`, and `DEV_EXEC_CHATGPT_CONSULT_TIMEOUT_MINUTES` controls are clamped to safe bounds (malformed values deny the opt-in). The local model can emit only the strict `{type:"REQUEST_CONSULTATION",prompt:string}` decision. Target, transport (`chatgpt_reply`), request ID, budgets, timeout, and durable state are runner-owned. Sensitive, destructive, account, permission, file, credential, personal-data, or unknown requests are blocked. Responses are untrusted bounded evidence and never become shell authority.

### Reusable handoff for autonomous consultation

For another Codex task, register the user-prepared ChatGPT URL first, then freeze
that alias for the run. Both direct conversation URLs
(`https://chatgpt.com/c/<safe-id>`) and project/custom-GPT-scoped URLs
(`https://chatgpt.com/g/<safe-slug>/c/<safe-id>`) are accepted; the complete URL
is preserved for navigation and the final segment is used as the conversation
identity. Enable standing ordinary-text consultation explicitly;
the local planner cannot choose a URL, tool, alias, or request ID. The adapter
passes the frozen `target_url` and derived
`expected_conversation_id` to `chatgpt_reply`, which navigates only to that
exact canonical URL and verifies the returned `chat_id`. Ask the user back when
intent is uncertain. Do not resend an ambiguous request. Secrets, credentials,
personal data, uploads or paths, permission/account/billing requests, and
destructive or out-of-scope instructions remain hard stops.

## Setup

```bash
# Install dependencies
npm install

# Install Playwright's Chromium
npx playwright install chromium

# Build
npm run build
```

### Claude Code config

Add to `~/.claude.json` under `mcpServers`:

```json
"chatgpt": {
  "type": "stdio",
  "command": "node",
  "args": ["/path/to/chatgpt-mcp/dist/index.js"]
}
```

### First use

On first `chatgpt_ask` call, a Chromium window opens at chatgpt.com. Log in manually once — cookies are persisted to `~/.chatgpt-mcp/user-data/state.json` for future sessions.

## Key design decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Browser engine | Playwright (Chromium) | Full DOM access, self-healing selectors, file upload support |
| Tool count | 5 | Orchestrator only needs ask/reply/upload/project/newchat |
| Session start | Auto on first call | No separate start_session step needed |
| Blocking by default | Yes | Matches Codex/Gemini ergonomics |
| Default timeout | 60 minutes | GPT-5.2 Pro can think 20+ minutes |
| Completion detection | Multi-indicator + content stability | Most robust: checks stop button, streaming flag, regen/copy buttons, send-enabled state, and 3 consecutive stable content checks |
| Response extraction | 5-strategy cascade | Handles ChatGPT UI changes: markdown containers → assistant role → articles → conversation turns → fallback |
| Polling | Fibonacci backoff | 2s, 3s, 5s, 8s, 13s, 21s, 30s+ — responsive for quick answers, efficient for long ones |

## Lineage

Merges the best of two prototypes:
- **gpt-bridge** — battle-tested response extraction, model selection, project management via Playwright
- **chatgpt-desktop-mcp** — blocking `ask` tool with Fibonacci backoff (was AppleScript-based, fragile)
