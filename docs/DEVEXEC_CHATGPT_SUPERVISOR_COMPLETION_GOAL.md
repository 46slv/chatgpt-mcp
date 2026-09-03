# Dev Exec — ChatGPT Supervisor Completion Goal

Status: active development goal
Last updated: 2026-09-03 JST
Baseline branch: `automation/devexec-codex-closed-goal-loop-20260902`
Verified baseline HEAD: `72068ebdfddf487c7b006d5ac0ebfcba1ed81bed`

## Goal

Make ChatGPT the top semantic supervisor for a Dev Exec ↔ Codex closed loop.

The intended operating loop is:

```text
exact Codex turn completes
  -> Dev Exec captures parent-verifiable completion evidence
  -> Local Model RELAY approves forwarding of the exact report hash
  -> exact task-bound ChatGPT Supervisor conversation
  -> ChatGPT evaluates Goal state
       CONTINUE    -> exact next task/prompt
       COMPLETE    -> semantic Goal completion
       NEEDS_HUMAN -> terminal escalation
  -> Dev Exec receives and correlates the exact response
  -> Local Model RELAY approves the exact return prompt hash
  -> Dev Exec queues the exact prompt to the exact original persisted Codex thread
  -> Codex executes the next turn
  -> repeat until ChatGPT returns COMPLETE or a safety terminal occurs
```

The operator supplies the exact ChatGPT conversation at runtime through `TaskChatBinding`. Real conversation URLs are not stored in tracked source or documentation.

## Primary unresolved proof

The immediate critical acceptance target is not merely that Dev Exec can invoke `codex queue`.

It is to prove, in one unattended real E2E chain, that:

```text
ChatGPT next-task response
  -> Local Model actually receives the return authorization request
  -> Local Model returns valid `RETURN_CODEX_PROMPT` approval for the exact prompt hash
  -> Dev Exec accepts that approval without allowing Local Model to rewrite routing or bytes
  -> Dev Exec queues the exact ChatGPT prompt to the exact bound Codex thread
  -> the resulting Codex turn starts and completes on that same thread
  -> the resulting completion report returns to ChatGPT without human copy/paste
```

A unit test, mocked relay, direct parent-side queue call, or manual prompt copy does not satisfy this proof by itself.

## Authority model

### ChatGPT Supervisor owns

- semantic Goal evaluation;
- whether current evidence is sufficient;
- `CONTINUE` versus `COMPLETE` versus `NEEDS_HUMAN`;
- exact next-task text when continuing;
- direction correction when Codex claims completion prematurely.

A Codex self-report such as `done` or `completed` is evidence only. It is not the semantic Goal-completion authority.

### Dev Exec parent owns

- canonical mission/task/run state;
- exact ChatGPT target binding;
- exact Codex thread binding;
- exact Codex runtime binding;
- report construction and parent-verifiable evidence;
- correlation, dedupe, leases, recovery and idempotency;
- actual queue invocation;
- fail-closed safety terminals.

### Local Model RELAY owns

Only bounded hash-level authorization.

For this path it may approve actions such as:

- `FORWARD_REPORT`;
- `RETURN_CODEX_PROMPT`.

It must not:

- choose the ChatGPT target;
- choose the Codex thread;
- choose the executable/runtime;
- rewrite ChatGPT prompt bytes;
- invent a replacement next task;
- issue arbitrary host commands.

The desired relationship is:

```text
Local Model decision
       ↓ bounded authorization
Dev Exec parent
       ↓ deterministic execution seam
Codex
```

not:

```text
Local Model
       ↓ arbitrary direct host control
Codex
```

## Development phases

### Phase A — Real return-leg proof

Prove the Local Model return leg independently and with real components.

Acceptance:

1. Start from a persisted exact Codex thread.
2. Produce a real completed Codex turn.
3. Send a correlated report to the runtime-supplied exact ChatGPT Supervisor.
4. Have ChatGPT return `CONTINUE` with a deterministic small repository task.
5. Local Model RELAY must actually approve the exact returned prompt hash as `RETURN_CODEX_PROMPT`.
6. Dev Exec must queue those exact bytes to the bound native Codex runtime and exact original thread.
7. Queue output must prove the same thread identity.
8. The resulting exact Codex turn must perform an observable repository action and complete.
9. That resulting turn must be reported back to ChatGPT automatically.
10. No human copy/paste, new thread creation, fuzzy session lookup, target fallback, or direct bypass of Local RELAY is allowed.

Required evidence should include at minimum:

- source turn id;
- relay request id;
- report SHA-256;
- ChatGPT response identity;
- returned prompt SHA-256;
- Local RELAY return approval identity;
- Codex continuation return id;
- queue submission id;
- bound thread id;
- resulting turn id;
- same-thread proof;
- repository evidence showing the queued task actually executed.

### Phase B — ChatGPT semantic completion loop

After Phase A is proven, make ChatGPT the semantic completion authority for normal autonomous operation.

Target decisions:

- `CONTINUE`: queue exact next task to the same bound Codex thread;
- `COMPLETE`: semantic Goal success, no queue;
- `NEEDS_HUMAN`: terminal escalation, no queue.

Fixed round count must not be the ordinary semantic completion mechanism in completion-driven mode.

Legacy bounded operation may remain available for compatibility and canaries, but production completion-driven operation should continue while evidence progresses until ChatGPT returns `COMPLETE` or a safety terminal occurs.

## Safety terminals retained by Dev Exec

ChatGPT owns semantic completion, but Dev Exec must still stop on unprovable or unsafe execution state, including:

- explicit operator cancellation;
- ChatGPT delivery ambiguity;
- Codex queue ambiguity;
- response correlation or hash mismatch;
- target/thread/runtime identity drift;
- cross-process lease or ownership conflict;
- persisted-state corruption that cannot be reconciled safely;
- unsafe context continuation / required explicit rotation;
- other states where an external side effect cannot be proven exactly.

Ambiguous external actions must not be blindly resent or reinjected.

## Non-goals

This goal does not require:

- Local Model becoming a second supervisor;
- Local Model rewriting ChatGPT instructions;
- automatic creation of fresh Codex threads after every task;
- removing exact runtime/thread/target bindings;
- weakening idempotency or fail-closed behavior;
- an unbounded process that ignores resource or safety failure;
- using arrival order, browser focus, `current-chat`, `--last`, PATH lookup, or fuzzy session names as routing authority.

## Final acceptance

This goal is complete only after a representative real development task proves all of the following without human relay:

1. Codex completes a task and Dev Exec detects the exact resulting turn.
2. The completion report reaches the exact ChatGPT Supervisor through Local Model RELAY.
3. ChatGPT can reject Codex's apparent completion and return a new task.
4. The Local Model return leg actually receives and approves the exact next-task hash.
5. Dev Exec queues that exact task to the same original Codex thread.
6. Codex performs the new task and reports again.
7. The cycle can repeat.
8. ChatGPT eventually returns `COMPLETE` based on evidence.
9. `COMPLETE` causes no further Codex queue injection.
10. Restart/recovery and ambiguous-delivery cases remain fail-closed and idempotent.

The key invariant is:

> ChatGPT decides whether the Goal is semantically complete; Local Model authorizes the bounded relay; Dev Exec owns deterministic routing and execution; Codex performs the work.

## Relationship to existing documents

Operational baseline and implemented current behavior remain defined by:

- `DEVEXEC_CLOSED_LOOP_RUNBOOK.md`;
- `DEVEXEC_TASK_BOUND_CHAT_TARGET.md`;
- `DEVEXEC_CONCURRENT_RELAY_SAFETY.md`;
- CGL-003/004/005 acceptance documents;
- current implementation and tests.

This document defines the next Goal and acceptance boundary. It does not retroactively claim that completion-driven Supervisor operation is already implemented or proven.
