# Dev Exec Closed Goal Loop — Operator Runbook

Status: implemented and real multi-round verified on branch `automation/devexec-codex-closed-goal-loop-20260902`.

Verified milestone: `ac674000f8415637ac4e894ba7b66b1f40c09797` (`feat: add bounded multi-round closed loop`).

This is the operational entrypoint for the current Codex ↔ Local Relay ↔ ChatGPT closed loop. Earlier design documents remain useful background, but this runbook describes the implemented same-thread system.

## What it does

Dev Exec can keep one persisted Codex task/thread under ChatGPT supervision without a human copying messages between the two systems:

```text
exact Codex turn completes
  -> parent-owned completion/status report
  -> Local Model RELAY (hash-only approval)
  -> exact task-bound ChatGPT conversation
  -> correlated ChatGPT decision
       CONTINUE -> exact prompt bytes
       STOP -> terminal
       NEEDS_HUMAN -> terminal
  -> Local Model RELAY (hash-only approval)
  -> exact bound native Codex runtime
  -> `queue` to the exact original Codex thread
  -> observe the resulting exact Codex turn
  -> repeat within configured bounds
```

The Local Model is deliberately not a task compiler or routing authority in this path. In `RELAY` mode it cannot rewrite the report or prompt, choose a ChatGPT target, choose a Codex thread, choose an executable, or issue arbitrary commands.

## Proven real behavior

The real CGL-005 probe completed three consecutive `CONTINUE` round-trips and then a correlated `STOP`, all on one persisted Codex thread. The controller stopped without an additional queue injection after `STOP`.

The real path also encountered and safely handled bounded schema/parser incompatibilities without blind resend. Recovery continued from exact persisted Codex turn evidence; ambiguous external side effects were not replayed.

## Safety / authority invariants

The following are not optional implementation details. They define the feature:

- Dev Exec parent state owns all routing and identity.
- ChatGPT target is an immutable `TaskChatBinding` containing an exact canonical conversation URL and conversation id.
- A running autonomous relay never falls back to `current-chat`, registry default, project config, browser focus, or legacy environment routing.
- Codex continuation is an immutable binding to one exact persisted thread/session UUID.
- Codex runtime is an immutable binding to an absolute executable path, version, capabilities, fingerprint evidence, and binding id.
- Normal return uses the bound native runtime's `queue` capability only. No `--last`, fuzzy session selection, PATH lookup, npm/PowerShell shim fallback, or automatic `resume` fallback.
- Local Model `RELAY` decisions are hash-only authorization envelopes. Parent-owned original bytes are the bytes actually sent or returned.
- ChatGPT replies are accepted only when `mission_id`, `task_id`, `relay_request_id`, and `report_sha256` match the parent request exactly.
- The same ChatGPT conversation is cross-process single-flight. Different conversations may progress concurrently.
- The same Codex loop/thread lineage has one cross-process owner.
- A source Codex turn, ChatGPT relay request, ChatGPT response, and Codex return are each idempotent by stable identity.
- `IN_FLIGHT` + uncertain result becomes fail-closed. Do not blindly resend or reinject.
- The multi-round controller is bounded. There is no implicit infinite loop.

## Main implementation modules

- `tools/devexec-task-chat-binding.mjs` — exact task-bound ChatGPT target.
- `tools/devexec-codex-runtime-binding.mjs` — exact Codex executable/version/capability/fingerprint binding.
- `tools/devexec-codex-continuation.mjs` — exact persisted thread return, queue-only sender, dedupe and identity proof.
- `tools/devexec-full-relay.mjs` — one correlated report → ChatGPT → same-thread return round, Local Model RELAY gates, conversation single-flight.
- `tools/devexec-closed-loop.mjs` — bounded multi-round controller and exact Codex app-server turn observer.

Supporting design references:

- `docs/DEVEXEC_TASK_BOUND_CHAT_TARGET.md`
- `docs/DEVEXEC_CONCURRENT_RELAY_SAFETY.md`
- `docs/tasks/DEV-CGL-003-FULL-RELAY.md`
- `docs/tasks/DEV-CGL-004-REAL-E2E-PROBE.md`
- `docs/tasks/DEV-CGL-005-BOUNDED-MULTI-ROUND.md`

## Prerequisites

Before admitting a real closed-loop task, the operator/parent must have all of the following:

1. An exact ChatGPT conversation URL prepared by the user/operator.
2. A persisted, non-ephemeral Codex thread/session for the task.
3. A native Codex runtime that has been explicitly selected and fingerprinted, with `queue=true`.
4. A Local Model RELAY adapter that implements only the strict hash-only decision contract.
5. A `chatgpt_reply` transport capable of taking `target_url` plus `expected_conversation_id`.
6. Parent-owned state directories for loop, full-relay, conversation arbitration, and recovery evidence.
7. Explicit bounded limits, especially `max_rounds`.

Do not put a user's real ChatGPT conversation URL in tracked source or documentation examples. Supply it at runtime and create the `TaskChatBinding` before the task starts.

## Current usage model

There is not yet a first-class `devexec closed-loop ...` CLI command in `tools/devexec.mjs`. The implemented API is currently consumed by a small driver/harness. Do not hide that fact by routing through the older `devexec run` target fallback path.

The primary controller API is:

```js
import { createClosedLoopOrchestrator } from "./tools/devexec-closed-loop.mjs";
```

A host/driver must create or load the three immutable bindings, provide the Local RELAY and exact ChatGPT/Codex adapters, and then run the bounded controller.

Conceptual shape:

```js
const loop = createClosedLoopOrchestrator({
  loop_id: "mission-loop-001",
  taskChatBinding,             // exact runtime-supplied ChatGPT URL/id
  codexContinuationBinding,    // exact persisted Codex thread UUID
  codexRuntimeBinding,         // absolute native codex.exe + fingerprint + queue
  stateDir,
  conversationStateDir,
  localRelay,                  // hash-only RELAY adapter
  chatgptTransport,            // exact TaskChatBinding transport
  invokeCodex,                 // bound native runtime process seam
  limits: {
    max_rounds: 8,
    turn_timeout_ms: 600000,
    chatgpt_timeout_ms: 1800000,
    local_relay_timeout_ms: 30000
  }
});

const result = await loop.run();
```

The production host should prefer the exact Codex app-server observer supplied by `createCodexAppServerTurnObserver` so turn completion is proven from the bound thread rather than inferred from process exit or transcript order.

## ChatGPT response contract

For each relay report, ChatGPT receives a correlation object and must return exactly one `devexec.codex-prompt` envelope.

`CONTINUE`:

```json
{
  "protocol": "devexec.codex-prompt",
  "schema_version": 1,
  "mission_id": "...",
  "task_id": "...",
  "relay_request_id": "sha256:...",
  "report_sha256": "sha256:...",
  "decision": "CONTINUE",
  "prompt": "exact text to queue to the bound Codex thread"
}
```

`STOP` and `NEEDS_HUMAN` use the same correlation fields and omit the continuation prompt. Neither terminal decision causes another Codex queue injection.

## Operating a real task

Recommended current procedure:

1. Start the work in a dedicated clean repo/worktree. Preserve unrelated dirty worktrees.
2. Select/create the exact ChatGPT conversation to supervise this task.
3. Start or capture the exact persisted Codex task/thread. Do not use an ephemeral thread if same-thread continuation is required.
4. Admission creates immutable TaskChat, Codex continuation, and Codex runtime bindings.
5. Set explicit `max_rounds` and time bounds.
6. Start the closed-loop driver.
7. Let the controller observe an exact completed Codex turn.
8. The controller sends one correlated report through Local RELAY to the bound ChatGPT conversation.
9. ChatGPT returns `CONTINUE`, `STOP`, or `NEEDS_HUMAN`.
10. On `CONTINUE`, the exact prompt is queued to the same Codex thread and the resulting exact turn is observed before the next report.
11. On any ambiguous external side effect, inspect persisted state; do not restart by blindly replaying the action.
12. Treat `STOP`, `NEEDS_HUMAN`, limits, drift, and ambiguity as terminal unless a separately audited recovery/rotation operation is performed.

## Multiple Codex tasks

Multiple independent Codex loops are supported by design.

- Task A/thread A and Task B/thread B keep independent immutable bindings and loop state.
- If they use different ChatGPT conversations, their ChatGPT round-trips may run concurrently.
- If they use the same ChatGPT conversation, only that conversation's awaited round-trip is serialized by the file-backed conversation lease.
- A waiting task keeps its frozen target, report hash, and thread binding. It does not resolve the target again when the slot becomes free.
- Responses are associated by exact correlation identity, never by arrival order.

## Terminal states to handle

The bounded controller exposes terminal or stop-like states including:

- `STOPPED`
- `NEEDS_HUMAN`
- `MAX_ROUNDS_REACHED`
- `DELIVERY_UNKNOWN`
- `REJECTED`
- `CANCELLED`

`CONTEXT_ROTATION_REQUIRED`/unsafe continuation should also stop rather than silently opening a replacement thread. Automatic fresh-thread context rotation is a separate future capability and must preserve lineage when implemented.

## What not to do

Do not:

- commit a real ChatGPT conversation URL;
- use `current-chat` or registry defaults for an admitted unattended task;
- use `codex --last` or fuzzy session names;
- fall back to a different Codex executable when queue is missing;
- let the Local Model rewrite completion reports or ChatGPT prompts in RELAY mode;
- retry a ChatGPT send whose delivery is uncertain;
- retry a Codex queue injection whose result is uncertain;
- associate a ChatGPT response or Codex turn by arrival order;
- enable an infinite daemon loop by removing `max_rounds`/time bounds.

## Verification baseline

For changes touching this feature, the minimum regression bar is:

```powershell
npm run test:devexec
npm run build
git diff --check
```

Also run the focused tests for any modified binding/relay/closed-loop module. Changes to external-send or queue semantics should include a bounded real canary before being considered operationally proven.

## Next operationalization steps

The next useful work is not to make the loop less bounded. It is to make admission easier while preserving the same invariants:

1. add a first-class `devexec closed-loop` CLI/facade that creates the immutable bindings explicitly;
2. run a small real development-task canary, not only harmless acknowledgement probes;
3. add safe context-rotation/handoff to a fresh Codex thread when the original context becomes too long;
4. run multi-Codex long-duration concurrency/soak tests;
5. retain exact target/thread/runtime lineage across every future convenience layer.
