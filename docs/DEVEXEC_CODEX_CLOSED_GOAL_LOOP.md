# Dev Exec — Codex ↔ Local Relay ↔ ChatGPT Closed Goal Loop

Status: design authority for the first implementation slices on branch `automation/devexec-codex-closed-goal-loop-20260902`.

Base: `main@24984b64e2d69652cc40136daee198d6330d1b78`.

## Goal

Prove a bounded, recoverable loop in which:

1. Dev Exec dispatches one Codex task.
2. Codex works in a fresh context through a bounded Worker Harness.
3. Parent-owned verification determines the terminal task result.
4. The verified completion is normalized and handed to the local model/relay.
5. The relay reports the completion to the frozen ChatGPT Supervisor target.
6. ChatGPT returns a bounded supervisor directive.
7. The local model compiles that directive into the next small task proposal.
8. Dev Exec validates authority, lineage, leases, and dedupe, then dispatches the next fresh Codex task.
9. The loop repeats until `STOP` or `NEEDS_HUMAN`.

The local model may also run its own bounded autonomous loop while the outer loop exists. The two loops must share Dev Exec authority and resource controls rather than becoming peer control planes.

## Architectural rule

There is one Control Plane and two loops.

```text
                         ChatGPT Supervisor
                        Goal / stop authority
                                |
                        SupervisorDirective
                                v
+------------------------------------------------------------------+
|                         Dev Exec Control Plane                    |
| canonical mission state / lineage / dedupe / leases / recovery   |
+--------------------------+---------------------+-----------------+
                           |                     |
                    OUTER LOOP              INNER LOOP
                           |                     |
                  Codex TaskContract       Local mission
                           |                     |
                           v                     v
                 fresh Codex Worker        Local model
                           |                bounded planner
                           v                     |
                  Worker Harness                v
                           |              typed local actions
                    parent verifier             |
                           |                     |
                  VerifiedCompletion            |
                           +----------+----------+
                                      |
                              evidence / events
```

### Outer loop

The outer loop advances the user-visible development Goal. ChatGPT is the supervisor for Goal continuation/stop decisions. Dev Exec remains the only canonical state owner and dispatcher.

### Inner loop

The local model can inspect, prepare, summarize, consult, and perform explicitly allowed typed local actions under a bounded budget. It may emit proposals and evidence. It does not own Mission state and cannot grant itself Codex dispatch authority.

## Authority matrix

| Responsibility | Owner |
| --- | --- |
| User Goal / supervisor continuation decision | ChatGPT Supervisor |
| Canonical Mission / Goal state | Dev Exec |
| Worker dispatch and action identity | Dev Exec |
| Repo/provider/device mutation lease | Dev Exec / parent runtime |
| Implementation attempt | Codex Worker or Local Worker, according to the granted task |
| Semantic Done / terminal completion evidence | parent Harness / Verifier |
| Completion normalization | Dev Exec |
| Completion summarization / task compilation | Local model relay |
| Transport target freeze and exactly-once-ish send state | Dev Exec |
| Retry/resume after ambiguous delivery or execution | Dev Exec, fail-closed |

No model may promote its own output to canonical completion or canonical Mission state.

## Existing components to reuse

Do not build a second Dev Exec state machine unless an existing seam is proven insufficient.

- `tools/dev-exec-loop.mjs`
  - frozen ChatGPT target
  - report hashing
  - `IN_FLIGHT` / `COMPLETED` supervisor send state
  - no automatic replay after ambiguous in-flight state
  - supervisor response parsing and bounded retries
- `tools/local-worker-iterative-runner.mjs`
  - bounded local planner rounds
  - typed actions
  - optional ChatGPT consultation
- `tools/local-worker-adapter.mjs`
  - local model planner + Local Executor seam
  - frozen consultation target
- `tools/mission-supervisor-io.mjs`
  - atomic supervisor escalation/repair files
- `tools/devexec-mission-supervisor-envelope.mjs`
  - strict supervisor escalation envelope
- `tools/local-provider-lease.mjs`
  - single-host local provider/device/port lease
- `tools/local-run-ledger.mjs`
  - bounded local run evidence
- `tools/local-runtime-recovery-journal.mjs`
  - parent-owned crash/recovery journal
- `46slv/codex-ephemeral-harness`
  - fresh Manager / Worker / Verifier contexts
  - runner-owned canonical transition
  - verified completion result
  - remains a Worker Harness, not a Dev Exec replacement

## Canonical event boundary

`codex exec` process exit is not a completion event.

The only outer-loop completion trigger is a parent-owned verified terminal result after the Harness has independently checked the task contract, diff, tests, evidence, paths, base/head expectations, and other required invariants.

```text
Codex exits
  -> Harness collects candidate result
  -> parent Verifier checks evidence
  -> terminal PASS / NO_GO / NEEDS_CONTEXT / FAILED
  -> Dev Exec emits one VerifiedWorkerCompletion
```

Inner and outer consumers subscribe to that single normalized event. They must not independently infer completion from process exit, stdout, a model claim, or a changed file.

## Protocol contracts

The exact JSON implementation may evolve during Phase 1, but these semantics are fixed.

### 1. VerifiedWorkerCompletion

Protocol name: `devexec.worker-completion`

Required semantic fields:

```json
{
  "protocol": "devexec.worker-completion",
  "schema_version": 1,
  "mission_id": "...",
  "goal_id": "...",
  "task_id": "...",
  "action_id": "...",
  "worker_kind": "codex",
  "outcome": "PASS",
  "repo": "...",
  "base_head": "...",
  "final_head": "...",
  "changed_files": [],
  "checks": [],
  "evidence_refs": [],
  "completed_at": "...",
  "completion_hash": "..."
}
```

Allowed outcomes for the first implementation: `PASS`, `NO_GO`, `NEEDS_CONTEXT`, `FAILED`.

`completion_hash` is derived by the parent from a canonical representation of the completion payload. A model does not supply or alter it.

### 2. SupervisorDirective

Protocol name: `devexec.supervisor-directive`

```json
{
  "protocol": "devexec.supervisor-directive",
  "schema_version": 1,
  "mission_id": "...",
  "parent_completion_hash": "...",
  "directive_id": "...",
  "decision": "CONTINUE",
  "next_goal": "...",
  "done_when": [],
  "constraints": [],
  "authority": "..."
}
```

Allowed decisions: `CONTINUE`, `STOP`, `NEEDS_HUMAN`.

A `CONTINUE` directive must bind to the exact `parent_completion_hash`. Stale directives are rejected.

### 3. CodexTaskContract

Protocol name: `devexec.codex-task`

The local model may compile a SupervisorDirective into this proposal, but Dev Exec validates and assigns the canonical action identity before dispatch.

Minimum semantics:

```json
{
  "protocol": "devexec.codex-task",
  "schema_version": 1,
  "mission_id": "...",
  "parent_directive_id": "...",
  "task_id": "...",
  "goal": "...",
  "done_when": [],
  "constraints": [],
  "repo": "...",
  "base_head": "...",
  "budget": {
    "max_attempts": 1
  }
}
```

The local model cannot directly execute this object. Dev Exec first validates Mission lineage, repo/base identity, task uniqueness, allowed authority, and mutation lease.

## State machine

The first real runtime should expose these logical outer states even if they map onto existing Dev Exec phase names.

```text
READY
 -> TASK_VALIDATED
 -> CODEX_DISPATCH_IN_FLIGHT
 -> CODEX_RUNNING
 -> VERIFYING
 -> COMPLETION_READY
 -> SUPERVISOR_IN_FLIGHT
 -> DIRECTIVE_RECEIVED
 -> TASK_COMPILE
 -> TASK_VALIDATED
 -> ...

terminal:
 STOPPED
 NEEDS_HUMAN
 DELIVERY_UNKNOWN
 EXECUTION_AMBIGUOUS
```

Ambiguous `SUPERVISOR_IN_FLIGHT` or Codex execution state never automatically replays the same action.

## Idempotency and lineage

Use explicit identities rather than transcript position.

- `completion_hash`: immutable parent-owned identity for one verified completion.
- Supervisor send dedupe key: `(mission_id, completion_hash)`.
- `directive_id`: unique identity for a Supervisor response, bound to one `completion_hash`.
- Codex dispatch dedupe key: `(mission_id, directive_id, task_id)` or a derived `action_id`.
- Applying the same directive twice must not launch two Workers.
- A different payload with an already-used identity is a hard conflict.
- Delivery timeout after `IN_FLIGHT` becomes `DELIVERY_UNKNOWN`; no blind resend.

## Coexistence with the Local autonomous loop

The inner loop is allowed to continue while a Codex task is running, with these constraints:

1. The inner loop has a hard round/time/action budget.
2. It cannot mutate the same repo/worktree while the outer Codex task holds the mutation lease unless Dev Exec explicitly granted disjoint scoped leases.
3. It cannot launch Codex directly.
4. It cannot change outer Goal/Mission state.
5. It may prepare `TaskProposal`, summaries, evidence indexes, or read-only research for the next outer cycle.
6. Any inner-loop completion is local evidence, not outer `GOAL_DONE`.

This keeps the local model useful during Codex execution without creating two competing coordinators.

## Resource model

At minimum, Dev Exec must distinguish:

- local inference provider/device/port lease
- repo/worktree mutation lease
- Codex dispatch/action lease
- ChatGPT transport send state

The existing provider lease protects the local inference path but is not by itself a repo mutation lock. A Codex/local-worker coexistence slice must explicitly prevent overlapping writes to the same mutation scope.

## Implementation slices

### Phase 0 — contract/design authority

This document.

Acceptance:
- one Control Plane / two loops is explicit
- owner of Goal, state, dispatch, Done, relay, and leases is explicit
- normalized completion, supervisor directive, and Codex task semantics are explicit
- ambiguous delivery/execution remains fail-closed

### Phase 1 — deterministic protocol seam, no real Codex or ChatGPT

Goal: prove the contracts and a two-cycle outer-loop transition without external model or transport dependencies.

Implement a small pure seam, preferably without changing `dev-exec-loop.mjs` unless required:

- strict validators/canonicalizers for `devexec.worker-completion`, `devexec.supervisor-directive`, and `devexec.codex-task`
- parent-owned deterministic completion hashing
- lineage validation (`parent_completion_hash`, `parent_directive_id`)
- duplicate same-payload acceptance / conflicting duplicate rejection
- a deterministic two-cycle test fixture:
  - fake verified completion A
  - fake supervisor `CONTINUE`
  - compiled/validated task B
  - fake verified completion B
  - fake supervisor `STOP`
- tests proving stale directive rejection and duplicate-dispatch prevention

Non-goals:
- real `codex exec`
- real ChatGPT Web transport
- daemon/scheduler
- changing Local Worker planner semantics
- general multi-agent framework

### Phase 2 — Codex Worker adapter

Add a Dev Exec Worker adapter that invokes the existing `codex-ephemeral-harness` contract or a compatible fresh `codex exec --ephemeral` harness entrypoint.

Requirements:
- Dev Exec supplies one validated TaskContract
- adapter returns candidate execution data only
- Harness/Verifier supplies terminal completion
- parent rechecks repo/base/head/diff/tests/evidence before emitting `VerifiedWorkerCompletion`
- no model-owned canonical state write
- no automatic re-execution after crash/stale/ambiguous state

### Phase 3 — real ChatGPT Supervisor transport

Reuse frozen target registry and `chatgpt_reply` transport semantics from `dev-exec-loop.mjs`.

Requirements:
- persist report payload and SHA-256 before send
- mark `IN_FLIGHT` before delivery
- one completion produces at most one automatic supervisor send
- timeout/delivery uncertainty is not auto-retried
- parse a strict `SupervisorDirective`
- stale or mismatched completion binding is rejected

### Phase 4 — Local Relay / Task Compiler + inner-loop coexistence

Use the local model as a bounded relay/compiler:

- summarize verified completion for supervisor delivery when useful
- convert a valid `CONTINUE` directive into a proposed `CodexTaskContract`
- preserve exact Goal/constraints rather than silently rewriting authority
- run under bounded context/round budgets
- enforce resource/mutation lease separation from active Codex work
- Dev Exec remains the final validator/dispatcher

### Phase 5 — real two-task vertical slice

Acceptance target:

```text
Task A
 -> fresh Codex
 -> parent verifier PASS
 -> VerifiedWorkerCompletion A
 -> local relay
 -> ChatGPT Supervisor CONTINUE
 -> local task compiler
 -> Dev Exec validates
 -> fresh Codex Task B
 -> parent verifier PASS
 -> VerifiedWorkerCompletion B
 -> ChatGPT Supervisor STOP
 -> Mission terminal state
```

Must complete two consecutive tasks without a human copying messages between systems.

Evidence must include exact task/action IDs, branch/base/final HEADs, changed paths, tests, completion hashes, supervisor send states, directive IDs, and proof that no duplicate Worker was launched.

## First Codex task

The first Codex implementation task is only Phase 1.

It should read this document, inspect the listed existing modules, implement the smallest protocol seam and tests, run the relevant tests, and stop. It must not wire a real Codex process or ChatGPT transport yet.

The intended result is a small verified contract layer that later phases can reuse without creating a second orchestration stack.
