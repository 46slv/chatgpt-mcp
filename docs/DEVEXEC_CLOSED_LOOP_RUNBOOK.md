# Dev Exec Closed Goal Loop — Operator Runbook

Status: implemented with completion-driven semantic supervision and legacy bounded compatibility on branch `automation/devexec-codex-closed-goal-loop-20260902`.

The current source of truth is the checked-in implementation and focused
completion-driven tests; real runtime canary evidence must remain runtime-only
and must not contain the supplied Supervisor URL.

This is the operational entrypoint for the current Codex ↔ Local Relay ↔ ChatGPT closed loop. Earlier design documents remain useful background, but this runbook describes the implemented same-thread system.

## What it does

Dev Exec can keep one persisted Codex task/thread under ChatGPT supervision without a human copying messages between the two systems:

```text
exact Codex turn completes
  -> parent-owned completion/status report
  -> Local Model RELAY (hash-only approval)
  -> exact task-bound ChatGPT conversation
  -> correlated ChatGPT decision
       CONTINUE -> exact prompt bytes to the same thread
       COMPLETE -> semantic terminal
       NEEDS_HUMAN -> human terminal
       STOP -> legacy stop terminal
  -> Local Model RELAY (hash-only approval)
  -> exact bound native Codex runtime
  -> `queue` to the exact original Codex thread
  -> observe the resulting exact Codex turn
  -> repeat until semantic terminal or explicit parent safety terminal
```

The Local Model is deliberately not a task compiler or routing authority in this path. In `RELAY` mode it cannot rewrite the report or prompt, choose a ChatGPT target, choose a Codex thread, choose an executable, or issue arbitrary commands.

## Contract and canary status

The completion-driven controller continues until a correlated `COMPLETE` or
`NEEDS_HUMAN`; a Codex self-report of "done" never terminates it. A legacy
bounded run may still stop at `MAX_ROUNDS_REACHED`. The focused and regression
tests exercise these semantics, including restart and fail-closed paths.

A real completion-driven canary is a separate acceptance gate. It must use a
harmless repository task, receive at least one exact `CONTINUE` from the fixed
Supervisor, queue that prompt into the same persisted Codex thread, and finish
with correlated `COMPLETE`. The checked-in CGL-005 evidence is a legacy
bounded/`STOP` canary and is not evidence of CGL-006 semantic completion. If
the operator cannot provide an eligible non-archived thread/worktree without
stealing an active writer, the canary is `NEEDS_HUMAN`; it must not be replaced
by a new thread, an unarchive, or a fallback target.

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
- Completion-driven mode has no ordinary fixed-round terminal. Optional
  `safety_max_rounds` and wall-clock budgets stop with `SAFETY_LIMIT_REACHED`;
  bounded mode retains `MAX_ROUNDS_REACHED`. There is no implicit unbounded
  daemon.

## Main implementation modules

- `tools/devexec-task-chat-binding.mjs` — exact task-bound ChatGPT target.
- `tools/devexec-codex-runtime-binding.mjs` — exact Codex executable/version/capability/fingerprint binding.
- `tools/devexec-codex-continuation.mjs` — exact persisted thread return, queue-only sender, dedupe and identity proof.
- `tools/devexec-full-relay.mjs` — one correlated report → ChatGPT → same-thread return round, Local Model RELAY gates, conversation single-flight.
- `tools/devexec-closed-loop.mjs` — bounded multi-round controller and exact Codex app-server turn observer.
- `tools/devexec-closed-loop-facade.mjs` — admission manifest, immutable binding assembly, and bounded facade operations.
- `tools/devexec-closed-loop-cli.mjs` — explicit `admit`, `run`, and `inspect` CLI surface.

Supporting design references:

- `docs/DEVEXEC_TASK_BOUND_CHAT_TARGET.md`
- `docs/DEVEXEC_CONCURRENT_RELAY_SAFETY.md`
- `docs/tasks/DEV-CGL-003-FULL-RELAY.md`
- `docs/tasks/DEV-CGL-004-REAL-E2E-PROBE.md`
- `docs/tasks/DEV-CGL-005-BOUNDED-MULTI-ROUND.md`
- `docs/tasks/DEV-CGL-006-COMPLETION-DRIVEN.md`

## Prerequisites

Before admitting a real closed-loop task, the operator/parent must have all of the following:

1. An exact ChatGPT conversation URL prepared by the user/operator.
2. A persisted, non-ephemeral Codex thread/session for the task.
3. A native Codex runtime that has been explicitly selected and fingerprinted, with `queue=true`.
4. A Local Model RELAY adapter that implements only the strict hash-only decision contract.
5. A `chatgpt_reply` transport capable of taking `target_url` plus `expected_conversation_id`.
6. Parent-owned state directories for loop, full-relay, conversation arbitration, and recovery evidence.
7. Explicit transport/time limits. Use `--until-complete` for semantic
   completion-driven operation; use `max_rounds` only for legacy bounded mode
   or `safety_max_rounds` when an explicit safety cap is required.

Do not put a user's real ChatGPT conversation URL in tracked source or documentation examples. Supply it at runtime and create the `TaskChatBinding` before the task starts.

## First-class CLI admission and usage

The first-class `devexec closed-loop ...` CLI/facade admits an existing
persisted Codex task/thread without creating a new thread. Admission requires
the exact mission/task/thread/initial-turn identities, the canonical ChatGPT
conversation URL, an absolute native `codex.exe` path, and an absolute bound
worktree. None of these values are inferred from current chat, mutable
defaults, browser focus, PATH, `--last`, or fuzzy session lookup.

Admission:

```powershell
node .\tools\devexec.mjs closed-loop admit `
  --mission-id <mission-id> `
  --task-id <task-id> `
  --thread-id <persisted-codex-thread-uuid> `
  --initial-turn-id <completed-turn-uuid> `
  --chat-url https://chatgpt.com/c/<conversation-id> `
  --runtime-path 'C:\Users\<user>\AppData\Local\OpenAI\Codex\bin\<revision>\codex.exe' `
  --working-directory 'D:\Documents\<dedicated-worktree>' `
  --repo-root 'D:\Documents\<dedicated-worktree>' `
  --until-complete `
  --goal '<goal text>' `
  --current-task '<current task text>'
```

The command probes the supplied runtime by its absolute path, requires native
`queue=true`, and proves the supplied persisted thread. If the thread already
has an active writer, admission uses bounded read-only polling of the exact
durable app-server history (with a bounded frame size) rather than creating or
resuming a different thread. The resulting immutable admission manifest is
stored under `%LOCALAPPDATA%\ChatGPTMCPProbe\closed-loop-admissions` unless
`--admission-root` is supplied.

Run or inspect an admitted task:

```powershell
node .\tools\devexec.mjs closed-loop run `
  --admission <admission-id-or-absolute-manifest-path> `
  --until-complete `
  --relay-url http://127.0.0.1:1234/v1 `
  --relay-model qwen/qwen3.5-4b `
  --mcp-config "$env:USERPROFILE\.lmstudio\mcp.json"

node .\tools\devexec.mjs closed-loop inspect --admission <admission-id-or-absolute-manifest-path>
```

The loop state and Full Relay state are persisted below the admission's
`state_dir`. A correlated `CONTINUE` is the only path that queues the exact
returned `devexec.codex-prompt` bytes to the bound thread. `COMPLETE`, `STOP`,
and `NEEDS_HUMAN` terminate without queueing. In-flight or ambiguous delivery
is terminal and is never automatically resent.

The primary controller API remains available for audited hosts:

```js
import { createClosedLoopOrchestrator } from "./tools/devexec-closed-loop.mjs";
```

A host/driver must create or load the three immutable bindings, provide the Local RELAY and exact ChatGPT/Codex adapters, and then run the controller. The parent should also provide a report-context provider so the Supervisor sees verifiable repository evidence.

Conceptual shape:

```js
const loop = createClosedLoopOrchestrator({
  loop_id: "mission-loop-001",
  taskChatBinding,             // exact runtime-supplied ChatGPT URL/id
  codexContinuationBinding,    // exact persisted Codex thread UUID
  codexRuntimeBinding,         // absolute native codex.exe + fingerprint + queue
  execution_mode: "completion-driven", // or "bounded" for legacy behavior
  stateDir,
  conversationStateDir,
  localRelay,                  // hash-only RELAY adapter
  chatgptTransport,            // exact TaskChatBinding transport
  invokeCodex,                 // bound native runtime process seam
  reportContextProvider,       // parent-owned goal/Git/tests/diff evidence
  limits: {
    max_rounds: null,          // ignored as a normal terminal in completion mode
    safety_max_rounds: null,
    turn_timeout_ms: 600000,
    chatgpt_timeout_ms: 1800000,
    local_relay_timeout_ms: 30000
  }
});

const result = await loop.run();
```

The production host should prefer the exact Codex app-server observer supplied by `createCodexAppServerTurnObserver` so turn completion is proven from the bound thread rather than inferred from process exit or transcript order.

## ChatGPT response contract

For each relay report, ChatGPT receives a parent-owned goal/evidence report and
must return exactly one correlated `devexec.codex-prompt` envelope. The
correlation fields are mandatory for every decision.

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

`COMPLETE`, `STOP`, and `NEEDS_HUMAN` use the same correlation fields and omit
the continuation prompt. None of those terminal decisions causes another
Codex queue injection. `COMPLETE` is semantic goal completion; `STOP` is a
legacy/operator stop; `NEEDS_HUMAN` requires intervention.

## Operating a real task

Recommended current procedure:

1. Start the work in a dedicated clean repo/worktree. Preserve unrelated dirty worktrees.
2. Select/create the exact ChatGPT conversation to supervise this task.
3. Start or capture the exact persisted Codex task/thread. Do not use an ephemeral thread if same-thread continuation is required.
4. Admission creates immutable TaskChat, Codex continuation, and Codex runtime bindings.
5. Select `completion-driven` (`--until-complete`) or legacy `bounded` mode.
   Set transport/time bounds and, if needed, an explicit
   `safety_max_rounds` (completion-driven) or `max_rounds` (bounded).
6. Start the closed-loop driver.
7. Let the controller observe an exact completed Codex turn.
8. The controller sends one correlated report through Local RELAY to the bound ChatGPT conversation.
9. ChatGPT returns `CONTINUE`, `COMPLETE`, `STOP`, or `NEEDS_HUMAN`.
10. On `CONTINUE`, the exact prompt is queued to the same Codex thread and the resulting exact turn is observed before the next report.
11. On any ambiguous external side effect, inspect persisted state; do not restart by blindly replaying the action.
12. Treat `COMPLETE`, `STOP`, `NEEDS_HUMAN`, safety limits, drift, and
    ambiguity as terminal unless a separately audited recovery operation is
    performed.

## Multiple Codex tasks

Multiple independent Codex loops are supported by design.

- Task A/thread A and Task B/thread B keep independent immutable bindings and loop state.
- If they use different ChatGPT conversations, their ChatGPT round-trips may run concurrently.
- If they use the same ChatGPT conversation, only that conversation's awaited round-trip is serialized by the file-backed conversation lease.
- A waiting task keeps its frozen target, report hash, and thread binding. It does not resolve the target again when the slot becomes free.
- Responses are associated by exact correlation identity, never by arrival order.

## Terminal states to handle

The controller exposes terminal or stop-like states including:

- `COMPLETE` — correlated ChatGPT semantic goal completion.
- `STOPPED`
- `NEEDS_HUMAN`
- `MAX_ROUNDS_REACHED` (legacy bounded mode)
- `SAFETY_LIMIT_REACHED` (completion-driven safety cap/budget)
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
- treat a Codex self-report of "done" as semantic completion;
- enable an unbounded daemon without an explicit operator safety budget.

## Verification baseline

For changes touching this feature, the minimum regression bar is:

```powershell
npm run test:devexec
npm run build
git diff --check
```

Also run the focused tests for any modified binding/relay/closed-loop module.
Changes to external-send or queue semantics should include a real canary in
which the Supervisor requests at least one additional task and then returns
`COMPLETE`; an acknowledgement-only probe is insufficient.

## Next operationalization steps

The completion-driven facade and focused tests are implemented. A real
development-task canary remains the next runtime-only acceptance gate and must
preserve these exact-identity invariants:

1. add safe context-rotation/handoff to a fresh Codex thread when the original context becomes too long;
2. run multi-Codex long-duration concurrency/soak tests;
3. retain exact target/thread/runtime lineage across every future convenience layer.
