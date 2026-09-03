# Dev Exec documentation index

This directory contains both current operational documentation and historical/design material. Start here rather than assuming every older design document describes the current runtime.

## Current operational entrypoints

### Closed Goal Loop

**Start with:** [`DEVEXEC_CLOSED_LOOP_RUNBOOK.md`](DEVEXEC_CLOSED_LOOP_RUNBOOK.md)

Current verified behavior:

```text
Codex exact completed turn
  -> Local Model RELAY
  -> exact task-bound ChatGPT conversation
  -> correlated CONTINUE / STOP / NEEDS_HUMAN
  -> Local Model RELAY
  -> bound native Codex runtime queue
  -> exact same Codex thread
  -> next exact turn
```

Real verification has completed three consecutive `CONTINUE` round-trips on one persisted Codex thread followed by a clean `STOP`.

**Next active development goal:** [`DEVEXEC_CHATGPT_SUPERVISOR_COMPLETION_GOAL.md`](DEVEXEC_CHATGPT_SUPERVISOR_COMPLETION_GOAL.md)

That goal makes the critical next proof explicit: a real ChatGPT next-task response must pass through the actual Local Model `RETURN_CODEX_PROMPT` gate and then reach the exact same persisted Codex thread without human copy/paste. After that proof, ChatGPT becomes the semantic Goal-completion authority (`CONTINUE` / `COMPLETE` / `NEEDS_HUMAN`) while Dev Exec retains deterministic routing, recovery, idempotency, and fail-closed safety authority.

Supporting authority/safety documents:

- [`DEVEXEC_TASK_BOUND_CHAT_TARGET.md`](DEVEXEC_TASK_BOUND_CHAT_TARGET.md) — exact immutable ChatGPT conversation binding; no unattended target fallback.
- [`DEVEXEC_CONCURRENT_RELAY_SAFETY.md`](DEVEXEC_CONCURRENT_RELAY_SAFETY.md) — multi-Codex isolation, conversation-scoped single-flight, response correlation.
- [`tasks/DEV-CGL-003-FULL-RELAY.md`](tasks/DEV-CGL-003-FULL-RELAY.md) — one-round relay contract.
- [`tasks/DEV-CGL-004-REAL-E2E-PROBE.md`](tasks/DEV-CGL-004-REAL-E2E-PROBE.md) — real one-round proof.
- [`tasks/DEV-CGL-005-BOUNDED-MULTI-ROUND.md`](tasks/DEV-CGL-005-BOUNDED-MULTI-ROUND.md) — current bounded multi-round acceptance contract.

Primary implementation:

- `tools/devexec-closed-loop-facade.mjs`
- `tools/devexec-closed-loop-cli.mjs`
- `tools/devexec-task-chat-binding.mjs`
- `tools/devexec-codex-runtime-binding.mjs`
- `tools/devexec-codex-continuation.mjs`
- `tools/devexec-full-relay.mjs`
- `tools/devexec-closed-loop.mjs`

The explicit operational surface is:

```text
node tools/devexec.mjs closed-loop admit ...
node tools/devexec.mjs closed-loop run --admission <id-or-manifest>
node tools/devexec.mjs closed-loop inspect --admission <id-or-manifest>
```

Admission accepts an existing persisted Codex task/thread and exact completed
source turn; it does not create a new thread. The canonical ChatGPT URL,
absolute native runtime, and absolute worktree are immutable inputs. If the
bound thread has an active writer, the facade uses bounded read-only exact
durable history rather than selecting another thread or replaying a delivery.

### Windows / Dev Exec setup

- [`DEVEXEC_WINDOWS_SETUP.md`](DEVEXEC_WINDOWS_SETUP.md)
- [`DEVEXEC_LOCAL_RUN_LEDGER.md`](DEVEXEC_LOCAL_RUN_LEDGER.md)

## Historical / earlier design material

[`DEVEXEC_CODEX_CLOSED_GOAL_LOOP.md`](DEVEXEC_CODEX_CLOSED_GOAL_LOOP.md) records the original closed-loop design exploration. Some early sections describe a Local Model task-compiler and fresh-Codex-task-per-cycle architecture. That is **not** the current operational behavior.

Current precedence for target, continuation, runtime and relay semantics is:

1. `DEVEXEC_CLOSED_LOOP_RUNBOOK.md`
2. `DEVEXEC_TASK_BOUND_CHAT_TARGET.md`
3. `DEVEXEC_CONCURRENT_RELAY_SAFETY.md`
4. CGL-003/004/005 task acceptance documents
5. implemented tests/modules
6. older `DEVEXEC_CODEX_CLOSED_GOAL_LOOP.md` design notes

The implemented outer loop normally returns the exact ChatGPT continuation prompt to the **same persisted Codex thread**. The Local Model is a hash-only `RELAY` gate in this path; it does not semantically rewrite the task or choose the next target.

## Safety rules that apply across the current system

- Do not commit a real ChatGPT conversation URL.
- Do not use `current-chat`, mutable defaults, browser focus, `--last`, fuzzy Codex session selection, or PATH resolution as unattended routing authority.
- Do not silently switch Codex executables when a required capability is missing.
- Do not retry ambiguous ChatGPT sends or Codex queue injections.
- Keep Local Model `RELAY` authority separate from Local Worker `AGENT` authority.
- Keep loops bounded by explicit rounds/time and stop on unprovable identity/causality.
- Preserve unrelated dirty worktrees; use dedicated worktrees for autonomous mutation.
