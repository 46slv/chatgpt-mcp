# DEV-CGL-003 — Full Relay one-round closed loop

This is the first slice that connects the already-implemented target binding, Codex continuation binding, and Codex runtime binding into one bounded relay round.

Read first:

- `docs/DEVEXEC_TASK_BOUND_CHAT_TARGET.md`
- `docs/DEVEXEC_CONCURRENT_RELAY_SAFETY.md`
- `docs/tasks/DEV-CGL-000-TARGET-BINDING.md`
- `docs/tasks/DEV-CGL-001-SAME-TASK-RETURN.md`
- `docs/tasks/DEV-CGL-002-CODEX-RUNTIME-BINDING.md`
- `tools/devexec-task-chat-binding.mjs`
- `tools/devexec-codex-continuation.mjs`
- `tools/devexec-codex-runtime-binding.mjs`
- the existing ChatGPT transport state in `tools/dev-exec-loop.mjs`
- the existing consultation transport helper in `tools/devexec-consultation.mjs`
- the existing local provider lease/recovery patterns before inventing new filesystem locking

## Goal

Implement one safe, bounded outer-loop round:

```text
validated Codex completion/status report
  -> Local Model RELAY gate
  -> exact task-bound ChatGPT conversation
  -> correlated ChatGPT Codex prompt
  -> Local Model RELAY gate
  -> exact bound native Codex runtime
  -> exact original Codex thread/session
```

This task must make that round deterministic, restart-safe, idempotent, and safe when multiple Codex tasks reach the relay concurrently.

Do not add a daemon, scheduler, background research loop, or general multi-agent framework.

## Authority chain

Dev Exec parent state is authoritative for all routing and identity:

- immutable `TaskChatBinding`
- immutable Codex continuation binding
- immutable Codex runtime binding
- relay request identity and report hash
- ChatGPT response correlation identity
- Codex return identity

Neither Codex output, Local Model output, browser focus, target registry defaults, PATH, nor arrival order may select a destination.

## Local Model: RELAY mode only

The Local Model must be present in the outer loop, but it is not a Task Compiler or routing authority in this mode.

Add a distinct bounded RELAY seam. Do not reuse normal Local Worker planner semantics as autonomous reasoning.

The Local Model may only authorize the next deterministic relay action against an already-persisted parent payload. It must not rewrite the report or ChatGPT prompt and must not supply target URLs, aliases, thread IDs, executable paths, or arbitrary commands.

Preferred shape:

```json
{
  "protocol": "devexec.local-relay-decision",
  "schema_version": 1,
  "request_id": "...",
  "payload_sha256": "sha256:...",
  "action": "FORWARD_REPORT"
}
```

and on the return leg:

```json
{
  "protocol": "devexec.local-relay-decision",
  "schema_version": 1,
  "request_id": "...",
  "payload_sha256": "sha256:...",
  "action": "RETURN_CODEX_PROMPT"
}
```

The parent must send/inject the exact persisted original payload bytes after validating this decision. Never use model-regenerated report/prompt text.

Any changed hash, unknown field, wrong action, target/thread/executable field, malformed output, timeout, or model uncertainty is fail-closed.

Keep this RELAY mode separate from the existing Local Worker AGENT mode.

## Relay request

Create a parent-owned correlated relay request from the validated Codex relay report and the three immutable bindings.

Minimum identity chain:

- `mission_id`
- `task_id`
- `task_chat_binding_id`
- `codex_continuation_binding_id`
- `codex_runtime_binding_id`
- `relay_request_id`
- exact report hash

The request ID/hash must be deterministic from stable identity where practical. Same identity + same report is idempotent. Same identity + different report is a hard conflict.

The payload sent to ChatGPT should include the useful human-readable Codex completion/status text plus a small machine-readable correlation envelope. Do not expose unnecessary local paths, secrets, model reasoning, or raw logs.

The target URL remains runtime task-bound state. Do not commit a real conversation URL to Git.

## Exact ChatGPT transport

The autonomous relay must use the already-validated `TaskChatBinding` exact `chat_url` and matching `conversation_id` directly.

Forbidden during send:

- ordinary `resolveTarget()` fallback
- `current-chat`
- registry `default_target`
- project `.devexec.json`
- legacy `CHATGPT_MCP_CHAT_URL` as routing authority
- focused browser tab as routing authority

It is acceptable to pass the exact bound URL to the MCP transport environment/arguments after validating it against the stored binding.

Persist the exact outbound payload and hash and `IN_FLIGHT` before the external ChatGPT send begins. On timeout, process loss, ambiguous MCP result, or uncertain delivery, transition to `DELIVERY_UNKNOWN` and do not automatically resend or re-resolve.

## Conversation-scoped concurrency

This is required for unattended multi-Codex operation.

Different exact ChatGPT conversations may have active relay sends concurrently.

The same exact conversation must be single-flight for an awaited supervisor round-trip. This must work across independent local processes, not only inside one JS `Map` or in-memory mutex.

Use a small parent-owned conversation arbitration/lease seam, reusing the safety patterns of existing local leases where practical.

Requirements:

- key by canonical conversation identity, not alias
- atomic single-host acquisition
- holder records task/request identity
- Task B waiting on the same conversation retains its already-frozen bindings and report hash
- when Task B later acquires the slot, it does not call `resolveTarget()` or use browser/default state
- do not silently take over a malformed/unprovable active lease
- if a prior owner died after external send entered `IN_FLIGHT`, treat that round as ambiguous and block automatic replay
- an item proven never to have started external delivery may remain eligible for later dispatch
- duplicate concurrent attempts for one relay request produce at most one external ChatGPT send

Do not create a general job queue. This is only conversation-scoped transport arbitration.

## ChatGPT response contract

Require a strict correlated response for Codex continuation, for example:

```json
{
  "protocol": "devexec.codex-prompt",
  "schema_version": 1,
  "mission_id": "...",
  "task_id": "...",
  "relay_request_id": "...",
  "report_sha256": "sha256:...",
  "decision": "CONTINUE",
  "prompt": "exact text to return to Codex"
}
```

Allowed decisions:

- `CONTINUE`
- `STOP`
- `NEEDS_HUMAN`

Validation is exact and fail-closed:

- mission/task must match
- relay request ID must match
- report hash must match
- only one response envelope may be accepted
- no association by arrival order
- malformed/fuzzy/multiple envelopes are rejected

`CONTINUE` produces one Codex continuation return request.

`STOP` and `NEEDS_HUMAN` are terminal for this round and must not inject a Codex prompt unless the contract explicitly carries a bounded prompt for a deliberate final acknowledgement. Prefer no injection for STOP/NEEDS_HUMAN in the first implementation.

## Codex return

For `CONTINUE`, pass the exact ChatGPT `prompt` bytes through the Local Model RELAY return gate, then create the existing parent-owned continuation return request.

Use:

- the exact stored Codex continuation binding
- the exact stored Codex runtime binding
- required mode = `queue`
- runtime drift/fingerprint verification immediately before injection

Normal unattended operation must use the bound native runtime with queue capability. No npm shim, PowerShell shim, PATH lookup, `--last`, fuzzy session name, alternate executable, or resume fallback.

The actual injected thread must prove exact equality with the bound original thread according to the CGL001 seam.

Ambiguous Codex injection is terminal/no blind reinjection.

## Persistent round state

Use a parent-owned bounded state/journal for the round. At minimum distinguish:

```text
PREPARED
WAITING_FOR_CONVERSATION_SLOT
CHATGPT_IN_FLIGHT
CHATGPT_RESPONSE_RECEIVED
LOCAL_RETURN_APPROVED
CODEX_IN_FLIGHT
COMPLETED
STOPPED
NEEDS_HUMAN
DELIVERY_UNKNOWN
REJECTED
```

Persist identities and payload hashes before each external side effect.

A restart must never infer success from missing state and must never blindly repeat a ChatGPT send or Codex injection that may already have happened.

## Tests

Use injected fake Local Model, ChatGPT transport, filesystem state directory, and Codex process adapter so the contract is mostly deterministic.

Prove at least:

1. Task A report -> Chat A -> correlated response -> thread A only.
2. Task A and Task B with different conversations may be active concurrently without cross-routing.
3. Task A and Task B sharing one conversation cannot have two awaited ChatGPT sends active simultaneously.
4. A waiting Task B retains its frozen ChatGPT binding after current/default alias changes.
5. Task A response cannot be consumed by Task B even when both share the same conversation.
6. duplicate concurrent relay request -> at most one ChatGPT external send.
7. duplicate concurrent Codex return -> at most one Codex injection.
8. same relay identity + changed report -> hard conflict.
9. response with wrong task/request/report hash -> reject.
10. malformed/multiple ChatGPT response envelopes -> reject.
11. Local Model changing payload hash -> reject before external action.
12. Local Model attempting to provide target/thread/executable/command fields -> reject.
13. ChatGPT timeout after `IN_FLIGHT` -> `DELIVERY_UNKNOWN`, no auto-retry.
14. Codex timeout after injection start -> continuation delivery unknown, no auto-reinject.
15. runtime fingerprint drift immediately before return -> reject, no PATH/alternate fallback.
16. exact native queue path is used; no resume fallback.
17. restart from persisted `CHATGPT_IN_FLIGHT` does not send again.
18. restart from persisted `CODEX_IN_FLIGHT` does not inject again.
19. conversation arbitration is cross-process/file-backed in shape; tests must not rely only on one in-memory mutex.
20. existing CGL000/001/002 tests remain green.

## Bounded real probe

After all deterministic tests and build pass, a real one-round probe is allowed if the exact runtime-only ChatGPT target and a safe persisted Codex probe thread are available.

Rules:

- target URL is supplied only at runtime; do not write it to tracked files
- use the bound native `codex.exe` runtime with queue required
- use a harmless persisted Codex probe thread/session or a deterministically captured current probe thread; never guess `--last`
- Local Model RELAY mode must participate on both legs
- exactly one ChatGPT outbound request maximum
- exactly one Codex queue injection maximum
- no automatic second relay round
- the ChatGPT request must ask for a correlated `devexec.codex-prompt` response
- choose a harmless continuation prompt that proves the same thread accepted it without modifying project files
- save bounded evidence locally outside tracked source if needed

If any precondition is missing, report `REAL_PROBE_BLOCKED` instead of weakening the contract.

## Constraints

- preserve dirty/protected `probe/windows-local`
- continue in the dedicated clean worktree
- do not commit a real ChatGPT conversation URL
- do not create/change GitHub Actions
- do not add a daemon/background loop
- do not expand Local Worker AGENT authority
- do not add target/PATH/session fallback
- do not auto-retry ambiguous sends
- do not start CGL004 or further autonomous looping in this task

## Done when

- Full Relay one-round orchestrator/seam exists
- Local Model RELAY mode is distinct and cannot rewrite/reroute payloads
- conversation-scoped cross-process single-flight exists
- ChatGPT response correlation is fail-closed
- exact native queue return to exact original Codex thread is wired
- focused tests pass
- `npm run test:devexec` passes
- `npm run build` passes
- `git diff --check` passes
- bounded real probe either PASSes or is explicitly `REAL_PROBE_BLOCKED` with concrete reason
- implementation changes are committed and pushed to this branch only after tests pass
- final report includes exact HEAD/remote SHA, changed files, test counts, local-model relay result, concurrency result, ChatGPT probe result, Codex same-thread proof, and next blocker

Stop after one-round Full Relay. Do not enable an unbounded automatic loop yet.
