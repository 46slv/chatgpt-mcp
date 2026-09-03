# Dev Exec — Concurrent Codex Relay Safety

Status: design requirement for the Codex ↔ Local Relay ↔ ChatGPT closed loop on `automation/devexec-codex-closed-goal-loop-20260902`.

## Goal

Multiple Codex tasks may complete or request supervisor continuation at nearly the same time without cross-routing, duplicate injection, or sending one task's report/response to another task/session.

This requirement is scoped to the closed-loop relay. It does not create a general-purpose scheduler or multi-agent framework.

## Core invariants

1. Every relay operation is bound to one immutable task identity, one immutable ChatGPT `TaskChatBinding`, and one immutable Codex continuation/thread binding.
2. No process-global `current task`, `current-chat`, `--last`, mutable default target, or fuzzy session selection may participate in unattended routing.
3. Different tasks may proceed concurrently when their ChatGPT conversations differ.
4. The same ChatGPT conversation is single-flight for supervisor sends: at most one outbound report/awaited supervisor response may be active for that conversation at a time.
5. A waiting report keeps its own task/binding/request identity. It is never re-resolved from mutable registry/default state when it later becomes eligible to send.
6. Every ChatGPT round-trip has a parent-owned correlation identity. A response is accepted only for the exact request/task/binding that created it.
7. Every Codex return has a parent-owned return identity and exact bound thread ID. A prompt for Task A can never be injected into Task B's thread.
8. Ambiguous transport or Codex injection state is fail-closed. No blind resend/re-injection.

## Identity chain

One outer-loop relay round should be traceable as:

```text
mission_id
  -> task_id
  -> task_chat_binding_id
  -> codex_continuation_binding_id
  -> relay_request_id
  -> outbound_report_hash
  -> supervisor_response_id / response_hash
  -> codex_return_id
  -> exact codex_thread_id
```

No stage may infer identity from ordering, transcript position, currently focused browser tab, mutable registry defaults, or 'most recent' Codex session.

## ChatGPT transport arbitration

### Different conversations

If Task A is bound to Chat A and Task B is bound to Chat B, both may send concurrently.

### Same conversation

If Task A and Task B are both bound to the same exact ChatGPT conversation, Dev Exec must serialize supervisor round-trips for that conversation.

Logical states per conversation:

```text
IDLE
 -> SEND_IN_FLIGHT(task A, relay_request A)
 -> RESPONSE_BOUND(task A, relay_request A)
 -> IDLE
 -> SEND_IN_FLIGHT(task B, relay_request B)
```

Task B may become `WAITING_FOR_CONVERSATION_SLOT`, but its immutable target and task identities are already frozen. When the slot becomes available, no `resolveTarget()`/default lookup occurs.

This is a conversation-scoped transport queue/arbitration seam only. It is not a generic work scheduler.

## Correlation envelope

The relay request to ChatGPT must carry enough non-secret identity for ChatGPT/Dev Exec to correlate the reply, for example:

```json
{
  "protocol": "devexec.relay-request",
  "schema_version": 1,
  "mission_id": "...",
  "task_id": "...",
  "relay_request_id": "...",
  "task_chat_binding_id": "sha256:...",
  "codex_continuation_binding_id": "sha256:...",
  "report_hash": "sha256:..."
}
```

The supervisor response accepted by Dev Exec must be bound to the exact relay request identity before its prompt is returned to Codex.

A response that cannot be unambiguously correlated is `RESPONSE_CORRELATION_MISMATCH` / `DELIVERY_UNKNOWN`, never guessed from arrival order.

## Codex return arbitration

Codex return state is task/thread scoped, not globally serialized unless the same bound Codex thread is targeted.

- Task A/thread A and Task B/thread B may receive prompts concurrently.
- Two return attempts for the same `codex_return_id` are idempotent; only one injection is allowed.
- Conflicting payload reuse of the same return identity is a hard failure.
- Two distinct tasks must not share one continuation binding unless explicitly modeled as the same task/session lineage.

## Crash/restart behavior

Before any external send/injection begins, persist:

- immutable task and target/thread binding identities
- request/return identity
- payload hash
- state = `IN_FLIGHT`

After restart:

- `IN_FLIGHT` is not automatically replayed.
- a waiting-but-never-started item may remain eligible once its conversation slot is available, provided its exact immutable bindings and payload hash still validate.
- changing `targets.json`, default aliases, focused tab, or current Codex session has no effect on persisted relay items.

## Required concurrency acceptance scenarios

1. Task A -> Chat A/thread A and Task B -> Chat B/thread B start at the same time; both remain correctly routed.
2. Task A and Task B target the same ChatGPT conversation; only one supervisor round-trip is active at once, and both responses return to the correct Codex threads.
3. Task A is in-flight while mutable `current-chat`/default target changes; A's routing is unchanged.
4. Task A response arrives; Task B must not consume it even if B is waiting on the same conversation.
5. Duplicate simultaneous delivery attempt for the same relay request produces one external send at most.
6. Duplicate simultaneous Codex return for the same return identity produces one injection at most.
7. Same identity with different payload is rejected.
8. Restart with conversation slot held/in-flight does not blindly resend.
9. Waiting Task B keeps its original exact binding when Task A releases the slot.
10. No test or implementation relies on arrival order as response identity.

## Implementation sequencing

`DEV-CGL-001-SAME-TASK-RETURN` must make continuation binding/dedupe state task-scoped and concurrency-safe in shape, including deterministic tests that two tasks cannot cross-route.

The later Full Relay slice must add conversation-scoped supervisor transport arbitration and response correlation before real unattended multi-Codex operation is accepted.
