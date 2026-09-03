# Dev Exec documentation index

This directory contains both current operational documentation and historical/design material. Start here rather than assuming every older design document describes the current runtime.

## Strategic architecture authority

- [`DEVEXEC_SELF_EVOLVING_ARCHITECTURE.md`](DEVEXEC_SELF_EVOLVING_ARCHITECTURE.md) — long-term Dev Exec architecture in which the deterministic Control Plane retains operational intelligence while Local Model, Codex, ChatGPT, Pi, and future agents remain replaceable. Defines Kernel / Reflex Engine / Skills / Forge / Ephemeral Agents, Decision Episode promotion, bounded self-maintenance, internet/GitHub operation boundaries, and one-way Obsidian reporting.
- [`DEVEXEC_MISSION_INTERFACE_AND_OBSERVABILITY.md`](DEVEXEC_MISSION_INTERFACE_AND_OBSERVABILITY.md) — operator-facing target contract: one external Request becomes one durable Mission, any bounded number of fresh disposable Episodes may run internally, and one canonical verified MissionResult is returned. Also defines exact running-Mission Event attachment and the read-only Mission Observatory boundary.
- [`DEVEXEC_MISSION_CLI.md`](DEVEXEC_MISSION_CLI.md) — Codex/automation-facing non-interactive CLI design: strict JSON/JSONL, exact Mission identity, stdin/file requests, idempotent Event submission, bounded waiting, resumable cursors, runtime/model status, canonical result retrieval, and shared Control Service semantics.
- [`goals/DEV-LER-001-LOCAL-EPHEMERAL-REASONING.md`](goals/DEV-LER-001-LOCAL-EPHEMERAL-REASONING.md) — first implementation component for fresh FIND / SOLVE / VERIFY / GOAL_CHECK reasoning episodes with durable Dev Exec state.
- [`goals/DEV-EVT-001-OPERATOR-EVENT-INGRESS.md`](goals/DEV-EVT-001-OPERATOR-EVENT-INGRESS.md) — typed new-Mission Task/Consultation admission, exact existing-Mission follow-up at safe fresh-Episode boundaries, idempotency/no-replay, and one canonical terminal MissionResult.
- [`goals/DEV-CLI-001-CODEX-MISSION-CLI.md`](goals/DEV-CLI-001-CODEX-MISSION-CLI.md) — implementation Goal for extending the existing `devexec` root with machine-stable Mission submit/followup/inspect/wait/result/events/episodes/runtime-status commands.
- [`goals/DEV-OBS-001-MISSION-OBSERVATORY.md`](goals/DEV-OBS-001-MISSION-OBSERVATORY.md) — loopback-only read-only projection of Mission, Episode, Event, actual runtime/model, resource, log, evidence, blocker, and terminal-result state.
- [`goals/README.md`](goals/README.md) — implementation Goal index and ordering guidance.

The strategic architecture is a target authority, not a claim that every component is implemented. Current operational behavior and exact command usage remain owned by the runbooks and live code/tests below.

The Mission interface Goals are deliberately separated:

```text
DEV-EVT-001  external Request/Event admission and MissionResult identity
DEV-LER-001  fresh bounded reasoning Episodes and durable continuity
DEV-CLI-001  Codex/automation-friendly machine client over the Control Service
DEV-OBS-001  human-readable read-only state/evidence projection
```

A running autonomous Mission receives new operator information through a typed Event for the exact `mission_id`; the Event is not injected into an already-running agent context. CLI and future Observatory controls must submit the same typed Events rather than becoming second launch or mutation paths.

The Mission CLI direction is:

```text
Codex -> Dev Exec
```

It remains distinct from the current exact Closed Goal Loop direction:

```text
Dev Exec -> exact persisted Codex thread
```

The CLI is a transport/inspection adapter, not an execution, Goal Control, Mission Governance, or verification authority.

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

### Existing root CLI

The current root command already dispatches operational families including:

```text
devexec target ...
devexec goal ...
devexec agent ...
devexec runtime ...
devexec closed-loop ...
devexec run / continue
devexec recover ...
```

`DEV-CLI-001` is a future extension of this root. The proposed `devexec mission ...` commands are not yet current operational entrypoints and must not be treated as implemented until their code/tests and live proof exist.

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
- Do not inject follow-up text into an already-running Ephemeral Episode; append a typed Event and apply it at a safe fresh boundary.
- Do not let a browser Observatory or CLI client own Mission persistence, state reduction, process execution, provider lifecycle, repository mutation, or action replay.
- Do not treat configured, selected, loaded, and active-Episode model identities as interchangeable.
- Do not create more than one canonical terminal MissionResult for one Mission.
- In future CLI machine mode, keep protocol JSON/JSONL on stdout and diagnostics on stderr; do not mix human prose into machine output.
- Do not let CLI callers select a current/latest Mission, self-assign a reasoning axis, or treat shell exit success as verified Mission completion.
