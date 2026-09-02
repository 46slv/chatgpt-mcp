# Dev Exec — Task-bound ChatGPT Target / Relay Safety

Status: authoritative correction for autonomous Codex completion routing on `automation/devexec-codex-closed-goal-loop-20260902`.

This document overrides any part of the older closed-loop design that allows an unattended completion report to choose a ChatGPT destination from a mutable default target, project fallback, legacy environment variable, or model inference.

## Problem

`tools/target-registry.mjs` intentionally supports interactive fallback resolution:

1. explicit alias
2. project `.devexec.json`
3. `targets.json.default_target`
4. legacy `CHATGPT_MCP_CHAT_URL`

That is useful for manual CLI operation, but unsafe as routing authority for an unattended Codex completion. A stale default or an older project binding can silently deliver a valid report to the wrong ChatGPT conversation.

## Core invariant

An autonomous Codex task has exactly one immutable return target binding created at task admission.

After admission, completion reporting MUST NOT call ordinary fallback `resolveTarget()` to decide where to send the report.

`targets.json` becomes a manual target catalog / admission input, not the runtime source of truth for an already-running task.

## Admission

Before the Codex task is dispatched, Dev Exec must obtain an explicit ChatGPT target by one of these bounded methods:

- an explicit target alias supplied by the launching Supervisor/CLI, resolved once; or
- an explicit exact ChatGPT conversation URL supplied by an authorized launcher; or
- `captureCurrentChat()` only during interactive admission when CDP identifies exactly one unambiguous current conversation.

No default/project/legacy fallback is accepted for autonomous task admission unless the caller explicitly converts that result into a confirmed/frozen admission input first.

If there is no unambiguous explicit target, task admission fails closed with `TARGET_BINDING_REQUIRED`.

## TaskChatBinding

Protocol: `devexec.task-chat-binding`

Minimum semantics:

```json
{
  "protocol": "devexec.task-chat-binding",
  "schema_version": 1,
  "mission_id": "...",
  "task_id": "...",
  "chat_url": "https://chatgpt.com/c/...",
  "conversation_id": "...",
  "source": "explicit-alias",
  "source_alias": "devexec-supervisor",
  "bound_at": "...",
  "binding_id": "sha256:..."
}
```

Rules:

- `chat_url` is canonicalized with the existing strict ChatGPT URL parser.
- `conversation_id` must match the URL.
- `source_alias` is provenance only after admission; it is not runtime routing authority.
- `binding_id` is parent-owned and derived from the canonical immutable binding fields.
- the binding is persisted in task/run state before Codex dispatch.
- Codex and the local model cannot alter the binding.

## Codex-facing behavior

Codex receives the frozen return target as part of its task metadata. It does not resolve `targets.json` itself.

When Codex produces a completion/status handoff, the report carries the exact task-bound target back unchanged:

```json
{
  "protocol": "devexec.codex-relay-report",
  "schema_version": 1,
  "task_id": "...",
  "completion": "what was completed",
  "situation": "current status / tests / remaining work",
  "return_target": {
    "binding_id": "sha256:...",
    "chat_url": "https://chatgpt.com/c/...",
    "conversation_id": "..."
  }
}
```

The parent verifies this target against its stored `TaskChatBinding`. A missing field or any mismatch is rejected before the local relay sees a sendable report.

The authoritative copy is parent state, not model output. A parent implementation may reconstruct `return_target` itself rather than trusting the Codex copy.

## Local Relay mode

For the outer Codex loop, the local model is a transparent relay, not a target selector and not a task compiler.

Allowed behavior:

1. receive the parent-validated Codex relay report;
2. format or wrap it only according to a fixed protocol template;
3. send it to the exact `chat_url` in the frozen binding;
4. receive the ChatGPT response;
5. extract the bounded Codex prompt envelope without semantic rewriting;
6. return that prompt to the same original Codex task/session through Dev Exec.

Forbidden behavior:

- resolving `current-chat` at report time;
- reading `targets.json.default_target` to choose a destination;
- using `.devexec.json` to choose a destination;
- using `CHATGPT_MCP_CHAT_URL` fallback to choose a destination;
- selecting a destination based on title, recent activity, visible tab, or model judgment;
- replacing the bound URL because an alias now points elsewhere.

## Direct bound transport

The autonomous transport path accepts a concrete frozen binding, not an alias.

Before send:

- validate canonical `chat_url` and `conversation_id` again;
- validate `binding_id` against parent state;
- persist the exact outgoing payload and SHA-256;
- persist `IN_FLIGHT` before invoking `chatgpt_reply`;
- key send identity by at least `(task_id, binding_id, report_hash)`.

On timeout or uncertain delivery, transition to `DELIVERY_UNKNOWN`. Do not re-resolve a target and do not automatically resend.

Whether the exact conversation is already open in CDP is an operational check, not permission to substitute another conversation. If the bound target cannot be reached, stop/fail closed rather than choosing a different target.

## ChatGPT response

ChatGPT returns a bounded prompt envelope for the same task. Example semantic contract:

```json
{
  "protocol": "devexec.codex-prompt",
  "schema_version": 1,
  "task_id": "...",
  "parent_report_hash": "...",
  "prompt_id": "...",
  "decision": "CONTINUE",
  "prompt": "exact text to send back to Codex"
}
```

Allowed decisions: `CONTINUE`, `STOP`, `NEEDS_HUMAN`.

For `CONTINUE`, the local relay returns the `prompt` bytes/text to Dev Exec without improving, summarizing, or rewriting them. Dev Exec routes by the stored Codex task/session identity. The local model does not choose which Codex task receives the prompt.

## Same-task continuation

Normal outer-loop behavior is:

```text
Codex Task A
  -> completion/status + frozen chat binding
  -> Local Relay
  -> exact bound ChatGPT conversation
  -> ChatGPT prompt
  -> Local Relay
  -> same Codex Task A
  -> continue
```

A fresh Codex task is created only when the Codex/Harness context must rotate, the original task is no longer resumable, or the Supervisor explicitly starts a new task. Rotation must carry the same frozen target binding unless an explicit rebind occurs.

## Explicit rebind only

Changing the target of an active task is a distinct state transition, not an edit to `targets.json`.

A rebind requires an explicit authorized `REBIND_TARGET` operation containing the old binding identity and new exact target. The operation creates a new `binding_id` and an audit event.

Registry edits, `target use`, `.devexec.json` changes, browser focus changes, or alias remapping must never implicitly rebind an active task.

## Concurrency

Each active Codex task carries its own immutable binding. Therefore two unattended tasks can safely target different conversations:

```text
Task A -> binding A -> Chat A
Task B -> binding B -> Chat B
```

There is no shared `current-chat` routing decision during completion handling.

## Required failure codes

The first implementation should distinguish at least:

- `TARGET_BINDING_REQUIRED`
- `TARGET_BINDING_INVALID`
- `TARGET_BINDING_MISMATCH`
- `TARGET_BINDING_TASK_MISMATCH`
- `TARGET_REBIND_REQUIRED`
- `DELIVERY_UNKNOWN`

All are fail-closed for autonomous send.

## Acceptance probes

The target-binding seam is not accepted until deterministic tests prove:

1. `targets.json.default_target` points at an old/wrong chat, while Task A still sends only to its frozen Chat A binding.
2. the default target changes after Task A starts; Task A target does not change.
3. the original alias is remapped after Task A starts; Task A target does not change.
4. Codex returns a different URL/conversation/binding ID; the report is rejected before send.
5. a report has no frozen binding; no fallback target is used and send is rejected.
6. Task A and Task B run concurrently with different bindings; no cross-delivery is possible.
7. an `IN_FLIGHT` send becomes ambiguous; it is not automatically resent and no alternate target is selected.
8. ChatGPT response with the wrong `task_id` or `parent_report_hash` is rejected.
9. a valid response is routed to the same original Codex task/session.
10. target change requires an explicit rebind event and produces a new binding identity.

## Existing code to reuse

- `tools/target-registry.mjs`
  - strict URL parsing
  - manual registry management
  - current-chat capture
  - existing frozen-target concepts
- `tools/dev-exec-loop.mjs`
  - payload hashing
  - persisted `IN_FLIGHT`/`COMPLETED` send state
  - no blind replay after ambiguous delivery
- `tools/target-verify.mjs`
  - exact CDP identity verification where useful

Do not delete interactive fallback resolution. Keep it for manual flows. Add a separate task-bound autonomous path that cannot invoke those fallbacks after admission.
