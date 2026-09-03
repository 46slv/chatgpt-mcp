# DEV-CGL-005 — Bounded multi-round closed loop

CGL004 proved one real end-to-end round:

```text
persisted Codex thread
  -> Local Model RELAY
  -> exact task-bound ChatGPT conversation
  -> correlated devexec.codex-prompt
  -> Local Model RELAY
  -> bound native codex.exe queue
  -> exact same Codex thread
```

This task extends that proven path to multiple consecutive rounds on the same Codex thread. It must preserve every CGL000–004 fail-closed authority boundary.

Read first:

- `docs/tasks/DEV-CGL-003-FULL-RELAY.md`
- `docs/tasks/DEV-CGL-004-REAL-E2E-PROBE.md`
- `docs/DEVEXEC_CONCURRENT_RELAY_SAFETY.md`
- `tools/devexec-full-relay.mjs`
- `tools/devexec-codex-continuation.mjs`
- `tools/devexec-codex-runtime-binding.mjs`
- current upstream Codex app-server thread/queue/turn notification behavior

## Goal

Implement one parent-owned bounded mission loop that can repeat the already-proven Full Relay round on one immutable task lineage:

```text
observe exact Codex turn completion
  -> build one bounded parent-owned completion/status report
  -> CGL003 Full Relay round
  -> exact ChatGPT CONTINUE prompt
  -> exact same Codex thread queue
  -> observe that exact queued turn complete
  -> next bounded report
  -> repeat
```

The loop ends on:

- ChatGPT `STOP`
- ChatGPT `NEEDS_HUMAN`
- configured `max_rounds`
- configured wall/time budget
- runtime/target/thread drift
- ambiguous ChatGPT delivery
- ambiguous Codex injection/observation
- malformed/correlation mismatch
- explicit operator cancellation
- context/continuation state that cannot be safely proven

Do not create an unbounded daemon or background scheduler in this slice.

## Primary design rule: observe Codex, do not make Codex route

The parent must determine when the exact bound Codex thread completes a turn. Codex model output must not choose the ChatGPT target, Codex runtime, continuation thread, loop round, or next destination.

Prefer current native Codex app-server/session mechanisms over transcript-file polling:

- resume/subscribe the exact persisted thread id
- observe `turn/started`
- observe `turn/completed`
- observe `thread/status/changed`
- use exact turn/thread ids to correlate completion
- use persisted thread reads/history only as a bounded recovery/read path when necessary

Do not infer completion from process exit alone, elapsed time, current/last session, focused UI, or arrival order.

If the installed native runtime cannot provide a deterministic event-observation path, stop and report the blocker rather than weakening identity guarantees.

## Codex completion source

For each accepted completed turn on the bound thread, construct a parent-owned round report from bounded observable evidence.

Minimum source identity:

- mission id
- task id
- exact bound thread id
- exact completed turn id
- turn status
- final assistant/agent message bytes or a bounded exact representation
- deterministic source-turn/report hash

The parent may package the exact final Codex message into the human-readable `completion` / `situation` fields expected by CGL003. Do not ask the Local Model to summarize or regenerate it.

A completed source turn may be admitted to the relay at most once.

If the same source turn is observed twice after reconnect/restart, it must resolve to the same round identity and be idempotent, not produce another ChatGPT send.

## Loop identity and persistence

Add a small parent-owned multi-round loop state, for example protocol `devexec.closed-loop-run` v1.

Minimum immutable identity:

- `loop_id`
- mission/task identity
- `TaskChatBinding` id
- Codex continuation binding id
- Codex runtime binding id/fingerprint
- exact Codex thread id
- configured limits

Minimum progress state:

- current round index
- last observed Codex turn id/hash
- current/last CGL003 relay request id
- current phase
- terminal reason
- created/updated timestamps

Suggested phases:

```text
READY
WAITING_FOR_CODEX_TURN
ROUND_PREPARED
RELAY_IN_PROGRESS
WAITING_FOR_CODEX_AFTER_CONTINUE
STOPPED
NEEDS_HUMAN
MAX_ROUNDS_REACHED
DELIVERY_UNKNOWN
REJECTED
CANCELLED
```

Persist the next phase/identity before each external side effect or transition that could be ambiguous.

Restart/reconnect must never cause a previously admitted Codex turn, ChatGPT send, or Codex injection to execute again automatically.

## Bounded limits

Implement explicit limits; no implicit infinity.

Suggested initial policy:

- `max_rounds`: required/configurable, range 1..20, default 8 for operator convenience
- per-Codex-turn wait timeout: bounded
- per-ChatGPT round timeout: reuse CGL003 bounds
- optional total wall-clock budget, bounded

Reaching a normal limit is a clean terminal state, not an error and not a reason to silently start another loop.

Do not automatically create a replacement Codex thread when context grows. If continuation becomes unsafe/unprovable, stop with a typed `CONTEXT_ROTATION_REQUIRED` / equivalent terminal reason. Context rotation is a later slice.

## Same-thread event observer

Add a narrow adapter around the bound native Codex app-server/session observation path.

The observer must:

1. use the exact CGL002-bound native runtime; no PATH/npm/PowerShell fallback.
2. target the exact CGL001 continuation thread id.
3. resume/subscribe only that thread.
4. reject notifications for another thread.
5. correlate each `turn/completed` to one exact turn id.
6. prove the completed turn came after the expected CGL003 queue submission when waiting after `CONTINUE`.
7. extract bounded final agent message/evidence without semantic rewriting.
8. fail closed on disconnect/timeout when completion state cannot be proven.

Where queue submission ids are available, preserve the causal chain:

```text
ChatGPT response
  -> codex_return_id
  -> queue submission id
  -> exact thread id
  -> resulting turn id
  -> turn/completed
  -> next report
```

Do not associate turns solely because they arrived next.

## Reuse CGL003 rather than duplicating it

Each round must invoke/reuse the existing Full Relay seam for:

- Local Model hash-only `FORWARD_REPORT`
- exact TaskChatBinding transport
- conversation-scoped cross-process single-flight
- strict ChatGPT response correlation
- Local Model hash-only `RETURN_CODEX_PROMPT`
- exact native runtime drift verification
- queue-only exact-thread continuation
- no automatic retry after ambiguous side effects

The multi-round controller owns sequencing only. It must not become a second target registry, second runtime resolver, second continuation router, or second ChatGPT transport implementation.

## ChatGPT decisions

For each round:

### CONTINUE

Queue the exact correlated ChatGPT `prompt` through the existing CGL003 return path, then wait for the resulting exact Codex turn completion and admit that completed turn as the next round's source report.

### STOP

Stop the loop cleanly. Do not queue another Codex prompt.

### NEEDS_HUMAN

Stop the loop in a distinct terminal state. Do not queue another Codex prompt.

## Concurrent Codex loops

Multiple independent Codex tasks/loops may run concurrently.

Requirements:

- loop state and observer ownership are keyed to exact task/thread lineage, not process-global current task/thread
- Task A/thread A and Task B/thread B may advance concurrently
- if both target different ChatGPT conversations, CGL003 may send concurrently
- if both target the same ChatGPT conversation, existing conversation-scoped single-flight serializes only the ChatGPT round-trip
- waiting Task B keeps its frozen bindings and source-turn/report identity
- two processes must not both own/advance the same loop/thread lineage simultaneously

Add a small cross-process loop-owner/observer lease or equivalent parent-owned exclusive ownership seam. Reuse existing safe file-backed lease patterns where practical. A malformed/unprovable/stale owner record must fail closed; do not silently steal it.

## Idempotency and ambiguity

At every level:

- source Codex turn: admit once
- relay request: send once
- ChatGPT response: correlate once
- Codex return: inject once
- resulting Codex turn: correlate once

Same identity + same bytes is idempotent.
Same identity + changed bytes is a hard conflict.

If ChatGPT was `IN_FLIGHT` at crash/disconnect, no automatic resend.
If Codex injection was `IN_FLIGHT` at crash/disconnect, no automatic reinjection.
If the observer loses the exact causal proof between queue submission and resulting turn, stop fail-closed; do not guess from the next turn.

## Deterministic tests

Prove at least:

1. three consecutive CONTINUE rounds stay on one exact Codex thread.
2. every completed turn gets a unique deterministic next relay identity.
3. duplicate observation of a completed turn does not create another ChatGPT send.
4. ChatGPT STOP terminates before another Codex injection.
5. NEEDS_HUMAN terminates before another Codex injection.
6. `max_rounds` terminates cleanly with no additional send.
7. wrong-thread `turn/completed` is ignored/rejected, never consumed.
8. wrong turn/submission causal chain is rejected.
9. observer reconnect sees an already-admitted turn and remains idempotent.
10. restart from CGL003 `CHATGPT_IN_FLIGHT` does not resend.
11. restart from `CODEX_IN_FLIGHT` does not reinject.
12. runtime fingerprint drift between rounds terminates without fallback.
13. TaskChatBinding remains unchanged if registry/default/current-chat changes mid-loop.
14. two loops on different threads cannot cross-route reports or prompts.
15. two loops sharing one ChatGPT conversation preserve CGL003 single-flight.
16. two processes cannot simultaneously acquire ownership of the same loop/thread lineage.
17. Local Model remains hash-only RELAY on every leg and never rewrites payloads.
18. no use of `--last`, fuzzy session names, PATH resolution, target fallback, or arrival-order correlation.
19. all CGL000–004 focused tests remain green.

## Real bounded multi-round probe

After deterministic tests/build pass, run one harmless real multi-round probe using a newly-created disposable persisted Codex thread and the runtime-only exact ChatGPT target supplied by the operator.

Do not reuse a work/project task thread for the initial proof.
Do not commit the real ChatGPT URL.

Acceptance probe:

- minimum 3 consecutive real `CONTINUE` round-trips
- all on the same exact persisted Codex thread
- Local Model RELAY participates on both legs of every round
- exactly one ChatGPT send and at most one Codex queue injection per round
- each new Codex completion is observed from exact app-server turn identity
- on the next ChatGPT request after the minimum proof, accept a correlated `STOP` so the controller demonstrates clean termination without another queue injection

Use harmless prompts/replies only; no project files or Git state should be modified by the probe thread.

If any delivery/observation becomes ambiguous, stop and report the exact terminal state. Do not retry that side effect.

## Bounded repair authority

This task may repair only seams directly required for bounded multi-round continuation/observation.

Allowed examples:

- exact app-server notification parsing
- queue-submission -> turn correlation
- persistent loop state/idempotency
- cross-process loop ownership
- bounded real-probe adapter

Not allowed:

- unbounded daemon/background scheduler
- fresh-thread/context rotation
- generic multi-agent framework
- target/runtime/session fallback
- Local Worker AGENT authority expansion
- auto-retry of ambiguous sends
- GitHub Actions changes

## Done when

- bounded same-thread multi-round controller exists
- exact Codex turn completion observation is parent-owned and causal
- repeated rounds reuse CGL003 and preserve CGL000–004 invariants
- concurrent loops are isolated and same-conversation ChatGPT traffic remains single-flight
- focused tests pass
- `npm run test:devexec` passes
- `npm run build` passes
- `git diff --check` passes
- real harmless probe proves at least 3 consecutive CONTINUE round-trips on one exact thread and then clean STOP, or reports a concrete fail-closed blocker
- any implementation changes are committed/pushed and remote SHA verified
- final report includes exact HEAD, test counts, observed round count, exact/safe thread proof, Local RELAY results, ChatGPT correlation results, queue/turn correlation results, concurrency findings, terminal state, and next blocker

Stop after bounded multi-round proof. Do not enable an infinite daemon or automatic context rotation in CGL005.
