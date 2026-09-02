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

### Explicit local runtime selector

The existing Cloud/LM Studio path remains the default. A local provider is never
selected automatically; opt in explicitly and inspect the selection first:

```powershell
node tools/devexec.mjs runtime select --runtime local --provider freetoken --enabled
```

Only bounded task contracts (goal, repository-relative allowed paths, exact
repo/worktree and base commit, and an argv-style test command) may be dispatched
through the local selector. Architecture, authority, integration, multi-repo,
destructive, and final-audit classifications are blocked. FreeToken lifecycle
start/stop remains owned by its adapter, while the parent runtime recomputes
Git changes and test evidence before accepting a result. Omit the flags (or use
`--disabled`) to retain the established path.

The public task entrypoint is explicit and contract-first. `--task` points to a
version-1 `TaskContract` JSON file; the file is size-bounded and unknown fields
are rejected before any provider is constructed. Results are a bounded,
redacted `ResultContract` on stdout. Use `--evidence <path>` (or `--log`) to
atomically save the same result plus a structured, redacted evidence record;
when omitted, the record is written under the user AppData directory rather
than this checkout. A test-only `--adapter-module` seam permits deterministic
fake providers without changing runtime routing:

```powershell
node tools/devexec.mjs runtime run --task .\task-contract.json `
  --runtime local --provider freetoken --evidence "$env:TEMP\devexec-evidence.json"
```

Local execution is never entered when the runtime/provider flags are omitted or
disabled. Exit status is `0` for `DONE`, `1` for `FAILED`, `2` for blocked or
invalid input, and `130` for cancellation.

The FreeToken adapter uses a provider-neutral minimal harness loop for local
coding tasks. OpenAI-compatible tool calls are bounded by the task's timeout,
call, history, search, and output limits. The typed tools are `read`, `search`,
`apply_patch`, `run_test`, and `git_diff`; writes are restricted to `allowed_paths`,
and duplicate tool failures stop the run. The parent then revalidates the Git
root/base commit, recomputes changed paths, and runs the fixed regression
command. This loop is constructed only for the explicit
`runtime=local,provider=freetoken` selection; Cloud and existing LM Studio
adapters are unchanged.

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

### DevExec Closed Goal Loop admission facade

The first-class `closed-loop` facade operationalizes the already-proven
bounded loop for an existing Codex task/thread. It never creates a new thread:
admission requires the exact persisted thread ID, an exact completed source
turn, the canonical ChatGPT URL, the absolute native `codex.exe` path, and the
absolute bound worktree.

```powershell
node .\tools\devexec.mjs closed-loop admit --mission-id <id> --task-id <id> `
  --thread-id <persisted-thread-uuid> --initial-turn-id <completed-turn-uuid> `
  --chat-url https://chatgpt.com/c/<conversation-id> `
  --runtime-path 'C:\Users\<user>\AppData\Local\OpenAI\Codex\bin\<revision>\codex.exe' `
  --working-directory 'D:\Documents\<dedicated-worktree>'

node .\tools\devexec.mjs closed-loop run --admission <id-or-manifest>
node .\tools\devexec.mjs closed-loop inspect --admission <id-or-manifest>
```

The facade keeps `TaskChatBinding`, persisted thread identity, and native
runtime identity immutable. The Local Model receives only the hash-only
`RELAY` envelope. A correlated `CONTINUE` is the sole path that queues the
exact returned `devexec.codex-prompt` bytes to the bound thread; `STOP` and
`NEEDS_HUMAN` terminate without queueing. There is no current-chat/default
target, PATH, `--last`, fuzzy-session, or automatic ambiguous-delivery retry.
`max_rounds` and all timeouts are explicit and bounded. See
[`docs/README.md`](docs/README.md) and
[`docs/DEVEXEC_CLOSED_LOOP_RUNBOOK.md`](docs/DEVEXEC_CLOSED_LOOP_RUNBOOK.md).

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
