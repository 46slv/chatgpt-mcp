# Dev Exec documentation index

This directory contains both current operational documentation and historical/design material. Start here rather than assuming every older design document describes the current runtime.

## Strategic architecture authority

- [`DEVEXEC_SELF_EVOLVING_ARCHITECTURE.md`](DEVEXEC_SELF_EVOLVING_ARCHITECTURE.md) — long-term Dev Exec architecture in which the deterministic Control Plane retains operational intelligence while Local Model, Codex, ChatGPT, Pi, and future agents remain replaceable. Defines Kernel / Reflex Engine / Skills / Forge / Ephemeral Agents, Decision Episode promotion, bounded self-maintenance, internet/GitHub operation boundaries, and one-way Obsidian reporting.
- [`goals/DEV-LER-001-LOCAL-EPHEMERAL-REASONING.md`](goals/DEV-LER-001-LOCAL-EPHEMERAL-REASONING.md) — first implementation component for fresh FIND / SOLVE / VERIFY / GOAL_CHECK reasoning episodes with durable Dev Exec state.

The strategic architecture is a target authority, not a claim that every component is implemented. Current operational behavior and exact command usage remain owned by the runbooks and live code/tests below.

## Current operational entrypoints

### Closed Goal Loop

**Start with:** [`DEVEXEC_CLOSED_LOOP_RUNBOOK.md`](DEVEXEC_CLOSED_LOOP_RUNBOOK.md)

Current verified behavior (completion-driven mode):

```text
Codex exact completed turn
  -> Local Model RELAY
  -> exact task-bound ChatGPT conversation
  -> correlated CONTINUE / COMPLETE / NEEDS_HUMAN (STOP remains compatible)
  -> Local Model RELAY
  -> bound native Codex runtime queue
  -> exact same Codex thread
  -> next exact turn
```

`COMPLETE` is the semantic completion authority. Codex's own completion text
is evidence only. Every cycle persists source-turn/report identity, the
Supervisor response and decision, exact next-task hash, queue/resulting-turn
ids, and same-thread proof. `max_rounds` remains the legacy bounded-mode
terminal; completion-driven mode does not use a fixed round cap as its normal
completion condition.

The real completion-driven canary is runtime-only and must show a Supervisor
`CONTINUE` followed by same-thread work and correlated `COMPLETE`; the older
CGL-005 `STOP` evidence does not satisfy that gate.

Supporting authority/safety documents:

- [`DEVEXEC_TASK_BOUND_CHAT_TARGET.md`](DEVEXEC_TASK_BOUND_CHAT_TARGET.md) — exact immutable ChatGPT conversation binding; no unattended target fallback.
- [`DEVEXEC_CONCURRENT_RELAY_SAFETY.md`](DEVEXEC_CONCURRENT_RELAY_SAFETY.md) — multi-Codex isolation, conversation-scoped single-flight, response correlation.
- [`tasks/DEV-CGL-003-FULL-RELAY.md`](tasks/DEV-CGL-003-FULL-RELAY.md) — one-round relay contract.
- [`tasks/DEV-CGL-004-REAL-E2E-PROBE.md`](tasks/DEV-CGL-004-REAL-E2E-PROBE.md) — real one-round proof.
- [`tasks/DEV-CGL-005-BOUNDED-MULTI-ROUND.md`](tasks/DEV-CGL-005-BOUNDED-MULTI-ROUND.md) — current bounded multi-round acceptance contract.
- [`tasks/DEV-CGL-006-COMPLETION-DRIVEN.md`](tasks/DEV-CGL-006-COMPLETION-DRIVEN.md) — completion-driven semantic terminal and cycle persistence contract.

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
node tools/devexec.mjs closed-loop run --admission <id-or-manifest> --until-complete
node tools/devexec.mjs closed-loop inspect --admission <id-or-manifest>
```

Admission accepts an existing persisted Codex task/thread and exact completed
source turn; it does not create a new thread. The canonical ChatGPT URL,
absolute native runtime, and absolute worktree are immutable inputs. If the
bound thread has an active writer, the facade uses bounded read-only exact
durable history rather than selecting another thread or replaying a delivery.
Select completion-driven operation with `--until-complete` (or
`--mode completion-driven` during admission); `COMPLETE`/`NEEDS_HUMAN` are
the normal terminals and any optional safety limit is reported separately.

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
- Keep transport and execution safety bounded (rounds only in legacy mode), and stop on unprovable identity/causality.
- Preserve unrelated dirty worktrees; use dedicated worktrees for autonomous mutation.
