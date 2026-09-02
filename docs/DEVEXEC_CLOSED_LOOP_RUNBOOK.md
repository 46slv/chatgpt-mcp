# Dev Exec Closed Goal Loop runbook

This is the operator facade for the already-proven bounded Closed Goal Loop.
It admits an existing persisted Codex task/thread and then delegates one
bounded round at a time to the existing `devexec-closed-loop.mjs` and
`devexec-full-relay.mjs` seams. It does not create a Codex thread.

## Admission

Admission requires the exact task identity, exact completed source turn, exact
ChatGPT conversation URL, exact native `codex.exe` path, and absolute worktree:

```powershell
node .\tools\devexec.mjs closed-loop admit `
  --mission-id <mission-id> `
  --task-id <task-id> `
  --thread-id <persisted-codex-thread-uuid> `
  --initial-turn-id <completed-turn-uuid> `
  --chat-url https://chatgpt.com/c/<conversation-id> `
  --runtime-path 'C:\Users\<user>\AppData\Local\OpenAI\Codex\bin\<revision>\codex.exe' `
  --working-directory 'D:\Documents\<dedicated-worktree>' `
  --repo-root 'D:\Documents\<dedicated-worktree>' `
  --max-rounds 8
```

`--chat-url`, `--thread-id`, and `--initial-turn-id` are not inferred. The
admission command probes the supplied runtime by its absolute path, requires
the native `queue` capability, and uses native `app-server` against the
supplied thread. If that thread already has an active writer, admission falls
back to bounded read-only polling of exact durable turn/item history; it does
not create or resume a different thread. Admission persists the exact turn
proof under
`%LOCALAPPDATA%\ChatGPTMCPProbe\closed-loop-admissions` unless
`--admission-root` is supplied.

## Run and inspect

```powershell
node .\tools\devexec.mjs closed-loop run `
  --admission <admission-id-or-absolute-manifest-path> `
  --relay-url http://127.0.0.1:1234/v1 `
  --relay-model qwen/qwen3.5-4b `
  --mcp-config "$env:USERPROFILE\.lmstudio\mcp.json"

node .\tools\devexec.mjs closed-loop inspect --admission <admission-id>
```

The loop state and Full Relay state are persisted below the admission's
`state_dir`. A successful `CONTINUE` is the only path that calls native
`codex queue --thread <bound-thread> --message <exact-prompt>`. STOP and
NEEDS_HUMAN terminate without queueing. In-flight or ambiguous delivery is a
terminal result and is never automatically resent.

## Invariants

- `TaskChatBinding`, the persisted Codex thread, and the native runtime are
  immutable admission inputs.
- The Local Model sees only the hash-only `RELAY` envelope and may not select a
  target, thread, path, command, or prompt bytes.
- ChatGPT receives the correlated `devexec.full-relay-report` through the
  bound `chatgpt_reply` MCP tool and must return one correlated
  `devexec.codex-prompt` envelope.
- The parent observes exact `thread/resume` and `turn/completed` identity; it
  does not use current chat, a default target, PATH, `--last`, fuzzy session
  lookup, or arrival order.
- `max_rounds`, turn, relay, and wall-clock limits remain bounded.

The CGL-005 implementation and its prior proof are not recreated by this
facade. A real canary should use an existing task/thread and a small, reversible
development change in its already-bound worktree.
