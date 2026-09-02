# Dev Exec documentation index

This directory separates the current operational closed-loop contract from
older design notes and the CGL acceptance records.

## Current operational entrypoint

Start with [`DEVEXEC_CLOSED_LOOP_RUNBOOK.md`](DEVEXEC_CLOSED_LOOP_RUNBOOK.md).
The first-class facade is exposed by:

```text
node tools/devexec.mjs closed-loop admit ...
node tools/devexec.mjs closed-loop run --admission <id-or-manifest>
node tools/devexec.mjs closed-loop inspect --admission <id-or-manifest>
```

Admission binds an existing persisted Codex task/thread, an exact completed
source turn, a canonical ChatGPT conversation, an absolute native runtime, and
an absolute worktree. It does not create a new thread. The run remains bounded
by explicit rounds and timeouts.

The operational path is:

```text
exact Codex turn
  -> hash-only Local Model RELAY
  -> bound ChatGPT conversation
  -> correlated CONTINUE / STOP / NEEDS_HUMAN
  -> exact prompt bytes to the same bound Codex thread only on CONTINUE
```

Supporting contract documents:

- [`DEVEXEC_TASK_BOUND_CHAT_TARGET.md`](DEVEXEC_TASK_BOUND_CHAT_TARGET.md) —
  immutable exact ChatGPT target and correlation.
- [`DEVEXEC_CONCURRENT_RELAY_SAFETY.md`](DEVEXEC_CONCURRENT_RELAY_SAFETY.md) —
  single-flight and ambiguous-delivery safety.
- [`tasks/DEV-CGL-003-FULL-RELAY.md`](tasks/DEV-CGL-003-FULL-RELAY.md) —
  one-round relay contract.
- [`tasks/DEV-CGL-004-REAL-E2E-PROBE.md`](tasks/DEV-CGL-004-REAL-E2E-PROBE.md) —
  real one-round proof.
- [`tasks/DEV-CGL-005-BOUNDED-MULTI-ROUND.md`](tasks/DEV-CGL-005-BOUNDED-MULTI-ROUND.md) —
  the prior bounded-loop proof; this facade does not recreate it.

Primary implementation modules:

- `tools/devexec-closed-loop-facade.mjs`
- `tools/devexec-closed-loop-cli.mjs`
- `tools/devexec-closed-loop.mjs`
- `tools/devexec-full-relay.mjs`
- `tools/devexec-task-chat-binding.mjs`
- `tools/devexec-codex-runtime-binding.mjs`
- `tools/devexec-codex-continuation.mjs`

## Non-negotiable routing rules

- `TaskChatBinding`, persisted thread identity, and native runtime identity are
  immutable after admission.
- The Local Model receives only the hash/action `RELAY` envelope; it cannot
  select a target, thread, path, command, or prompt bytes.
- Only a correlated `CONTINUE` queues the exact returned
  `devexec.codex-prompt` bytes to the bound thread.
- `STOP`, `NEEDS_HUMAN`, in-flight, and ambiguous delivery states never queue
  or automatically resend.
- No current-chat, mutable default, PATH, `--last`, fuzzy session lookup, or
  arrival-order routing is used.
- Preserve unrelated dirty worktrees and use a dedicated bound worktree for
  autonomous mutation.

Historical architecture notes in
[`DEVEXEC_CODEX_CLOSED_GOAL_LOOP.md`](DEVEXEC_CODEX_CLOSED_GOAL_LOOP.md) are
not authority when they conflict with this runbook and the implemented tests.
