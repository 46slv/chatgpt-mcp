# chatgpt-mcp / Dev Exec

`chatgpt-mcp` provides a blocking MCP bridge to the ChatGPT web UI and is also the Windows-side home of **Dev Exec**, the control plane used to connect ChatGPT, Codex, and bounded local-model execution.

The ChatGPT bridge uses Playwright/Chromium and exposes an `ask/reply -> response` style interface. Dev Exec adds task identity, target/runtime binding, leases, recovery, local execution, and supervised Codex orchestration on top of that transport.

## Major Dev Exec capability: Closed Goal Loop

Dev Exec can now run a bounded multi-round supervision loop on one exact persisted Codex thread:

```text
Codex turn completes
  -> parent-owned completion/status report
  -> Local Model RELAY (hash-only)
  -> exact task-bound ChatGPT conversation
  -> ChatGPT: CONTINUE / STOP / NEEDS_HUMAN
  -> Local Model RELAY (hash-only)
  -> exact bound native Codex runtime
  -> queue to the exact same Codex thread
  -> observe exact resulting turn
  -> repeat within configured bounds
```

The real CGL-005 verification completed **3 consecutive CONTINUE round-trips on one persisted Codex thread and then a clean STOP**. The loop is bounded and fail-closed; it is not an infinite daemon.

Important properties:

- ChatGPT destination is frozen per task as an exact URL + conversation id. No unattended fallback to `current-chat`, registry default, project config, browser focus, or legacy routing.
- Codex continuation is frozen to one exact persisted thread UUID.
- Codex runtime is frozen to an absolute executable path plus version/capability/fingerprint evidence.
- Normal continuation requires the bound native runtime's `queue` capability. No `--last`, fuzzy session name, PATH/npm/PowerShell fallback, or automatic resume fallback.
- The Local Model has a separate **RELAY** mode. It authorizes hashes only and cannot rewrite the report/prompt or choose targets, threads, executables, or commands.
- ChatGPT replies are accepted only with exact mission/task/request/report-hash correlation.
- Multiple Codex tasks can run concurrently. The same ChatGPT conversation is cross-process single-flight; different conversations may progress concurrently.
- Ambiguous ChatGPT sends or Codex injections are not blindly retried.
- `STOP`, `NEEDS_HUMAN`, configured limits, runtime drift, and unprovable causality terminate the loop safely.

See **[`docs/DEVEXEC_CLOSED_LOOP_RUNBOOK.md`](docs/DEVEXEC_CLOSED_LOOP_RUNBOOK.md)** for the current architecture, prerequisites, operating procedure, API shape, multi-Codex behavior, and safety rules.

Current implementation modules:

- `tools/devexec-task-chat-binding.mjs`
- `tools/devexec-codex-runtime-binding.mjs`
- `tools/devexec-codex-continuation.mjs`
- `tools/devexec-full-relay.mjs`
- `tools/devexec-closed-loop.mjs`

The multi-round controller currently exists as an API/harness seam; a first-class `devexec closed-loop ...` CLI is a follow-up operationalization task. Do not route this feature through the older mutable-target fallback path just for convenience.

## ChatGPT MCP tools

| Tool | Description |
| --- | --- |
| `chatgpt_ask` | Send a prompt, optionally switch model/project, wait for completion, return response |
| `chatgpt_reply` | Follow up in a conversation; Dev Exec can target an exact prepared conversation using `target_url` + `expected_conversation_id` |
| `chatgpt_upload` | Upload files with an optional prompt and wait for response |
| `chatgpt_select_project` | Navigate to a ChatGPT Project by name |
| `chatgpt_new_chat` | Start a fresh conversation |

All tools are blocking: the MCP call returns when ChatGPT has completed or the bounded timeout is reached.

## Architecture

```text
                         ChatGPT Web
                             ^
                             | exact chatgpt_reply target
                             |
                    +------------------+
                    |  Dev Exec Parent |
                    | state / bindings |
                    | leases / recovery|
                    +---------+--------+
                              |
                +-------------+-------------+
                |                           |
        Closed Goal Loop              Local runtime
                |                           |
     persisted Codex thread       LM Studio / FreeToken
                |                 bounded typed harness
        native Codex runtime

ChatGPT web transport:
Dev Exec / MCP client -> chatgpt-mcp -> Playwright -> persistent Chromium -> chatgpt.com
```

Dev Exec remains the routing/control authority. Models produce bounded outputs and evidence; they do not become peer control planes.

## Dev Exec target handling

Manual/interactive target registry operations are still available:

```powershell
node tools/devexec.mjs target set <alias> <chatgpt-conversation-url>
node tools/devexec.mjs target use <alias>
node tools/devexec.mjs target current
```

For an admitted autonomous Closed Goal Loop, however, the registry alias is only an admission input/provenance source. The parent creates an immutable task binding from the exact URL. Changing the alias/default later must not reroute the active task.

The exact user conversation URL should remain runtime state and should not be committed to Git.

## Existing Dev Exec commands

```text
devexec target ...
devexec goal <goal> [--target <alias>]
devexec agent start|resume|status ...
devexec runtime select ...
devexec runtime run ...
devexec runtime metrics ...
devexec runtime recovery ...
devexec run [--target <alias>]
devexec continue <run-id> [--target <alias>]
devexec recover inspect|reconcile|verify-journal ...
```

The legacy/general `devexec run` path and the Closed Goal Loop are related but not interchangeable: the latter has stricter task-bound ChatGPT, Codex-thread, and runtime identities.

## Local runtime

Cloud/established paths remain available. A local provider is selected explicitly; it is not silently chosen:

```powershell
node tools/devexec.mjs runtime select --runtime local --provider freetoken --enabled
```

A local coding task is contract-first:

```powershell
node tools/devexec.mjs runtime run --task .\task-contract.json `
  --runtime local --provider freetoken `
  --evidence "$env:TEMP\devexec-evidence.json"
```

Local mutation is restricted by the TaskContract. The parent recomputes Git changes and test evidence before accepting a result. Provider/device/port leases, recovery journals, and bounded evidence prevent local-model execution from becoming an uncontrolled side channel.

The local autonomous **AGENT** mode is distinct from Closed Goal Loop **RELAY** mode. Do not merge their authority: RELAY is transport authorization only; AGENT may perform only explicitly granted bounded local actions.

## Bounded ChatGPT consultation

The local worker can separately request bounded ordinary-text consultation from one frozen ChatGPT target when explicitly enabled:

```text
DEV_EXEC_CHATGPT_CONSULT_ENABLED=1
DEV_EXEC_CHATGPT_CONSULT_TARGET_ALIAS=<alias>
```

Optional request/character/evidence/timeout limits are bounded. Sensitive, destructive, credential, account, permission, upload/path, personal-data, and unknown consultation requests are blocked. ChatGPT consultation responses are untrusted evidence, not shell authority.

This consultation path is not the same as Closed Goal Loop RELAY.

## Setup

```bash
npm install
npx playwright install chromium
npm run build
```

### MCP client configuration

Configure an MCP client to start the built server over stdio, for example:

```json
{
  "mcpServers": {
    "chatgpt": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/chatgpt-mcp/dist/index.js"]
    }
  }
}
```

### First browser use

On the first ChatGPT call, Chromium opens at `chatgpt.com`. Complete login manually once. Browser state is persisted for subsequent sessions.

## Development / verification

General build:

```bash
npm run build
```

Dev Exec regression suite:

```bash
npm run test:devexec
```

For changes touching task binding, continuation, runtime binding, Full Relay, or the multi-round loop, also run the relevant focused tests and:

```bash
git diff --check
```

Changes to external send/queue semantics should be considered operationally proven only after a bounded real canary. Never weaken correlation or replay safety simply to make a canary pass.

## Closed-loop design references

- [`docs/DEVEXEC_CLOSED_LOOP_RUNBOOK.md`](docs/DEVEXEC_CLOSED_LOOP_RUNBOOK.md) — current operational guide
- [`docs/DEVEXEC_TASK_BOUND_CHAT_TARGET.md`](docs/DEVEXEC_TASK_BOUND_CHAT_TARGET.md) — immutable ChatGPT target authority
- [`docs/DEVEXEC_CONCURRENT_RELAY_SAFETY.md`](docs/DEVEXEC_CONCURRENT_RELAY_SAFETY.md) — multi-Codex/conversation concurrency rules
- [`docs/tasks/DEV-CGL-003-FULL-RELAY.md`](docs/tasks/DEV-CGL-003-FULL-RELAY.md) — one-round Full Relay acceptance contract
- [`docs/tasks/DEV-CGL-004-REAL-E2E-PROBE.md`](docs/tasks/DEV-CGL-004-REAL-E2E-PROBE.md) — first real E2E proof
- [`docs/tasks/DEV-CGL-005-BOUNDED-MULTI-ROUND.md`](docs/tasks/DEV-CGL-005-BOUNDED-MULTI-ROUND.md) — bounded multi-round acceptance contract

## Background

The original project began as a browser bridge that gave web-only ChatGPT capabilities the same blocking `ask -> response` ergonomics as CLI models. Dev Exec grew around that bridge into a local control plane for supervised coding, bounded local inference, recovery, evidence, and task-safe model orchestration.
