# DEV-TCA-001 — Automatic per-Task ChatGPT Conversation Admission

Status: READY_FOR_IMPLEMENTATION / TASK BRIEF  
Date: 2026-09-21  
Repository: `46slv/chatgpt-mcp`  
Authoring base: `main@3bba7977b4cc7b338b6f1516e4e2c4adfb327cd2`

## Outcome

Make ChatGPT conversation provisioning a first-class Task admission operation so a durable Task lineage no longer needs a manually prepared ChatGPT URL.

The required invariant is:

```text
1 durable Task lineage = 1 immutable ChatGPT conversation binding
```

For a genuinely new Task, Dev Exec creates one fresh ChatGPT conversation, sends one bounded seed packet, captures the canonical conversation URL + `conversation_id`, creates the existing immutable `TaskChatBinding`, and then uses that binding for all later REPORT / CONSULT / Closed Goal Loop traffic.

Context refresh, compaction, fresh Codex/Astra/Luna/Muse execution, or executor replacement inside the same Task must preserve the same binding. A genuinely new Task gets a new conversation.

## Current truth

The repository already has the pieces that must remain authoritative:

- `tools/devexec-task-chat-binding.mjs` owns `devexec.task-chat-binding` and exact URL / conversation-id validation.
- `tools/devexec-closed-loop-facade.mjs` persists the immutable `TaskChatBinding` inside Closed Goal Loop admission.
- `src/chatgpt.ts` already has fail-closed user-turn acknowledgement, canonical conversation parsing, exact-target REPORT / CONSULT transport, and post-send target re-verification.
- `checkpoint_bind/save/status/dispatch` and the landed checkpoint autoreport path already consume exact targets.
- `chatgpt_new_chat` can navigate to a fresh conversation surface, but today it does not seed, capture, durably claim, or bind a Task.
- Current Closed Goal Loop admission still requires `--chat-url`.

Do not create a second target-binding schema and do not redesign the checkpoint/report protocol.

## Product decision

The normal automatic path is:

```text
Task admission
  -> durable Task-chat admission claim
  -> fresh ChatGPT conversation
  -> one bounded seed send
  -> exact USER_TURN_ACK
  -> capture canonical chat URL + conversation_id
  -> create/freeze existing TaskChatBinding
  -> persist BOUND result
  -> start/continue Worker
  -> REPORT / CONSULT always use this binding
```

The model/Worker never chooses or infers the destination.

Mutable aliases, browser focus, current chat, registry default, project fallback, recent-chat heuristics, and model judgment are never post-admission routing authority.

## Identity

The admission identity is parent-owned and deterministic from the durable lineage:

```text
mission_id + task_id
```

Use a stable `admission_id` derived from those exact values. Repeating admission for the same `mission_id + task_id` must converge to the same persisted binding without another ChatGPT send.

If a caller intends a genuinely new Task, it must provide a new `task_id`.

A different immutable request presented for an already claimed Task must fail as an admission conflict; it must not silently create another conversation.

## Binding

Reuse `createTaskChatBinding()`.

Expected provenance for an automatically provisioned binding:

```text
source = auto-task-admission
source_alias = <admission_id or null; provenance only>
```

The existing `TaskChatBinding` remains the runtime target authority.

Do not persist the real ChatGPT URL into generic tracked repository documents. Runtime admission state may contain the exact URL because exact transport requires it.

## Seed packet

The seed exists only to create/correlate the new conversation and establish a canonical conversation identity. Keep it bounded and mechanically generated. Do not send raw repo context, logs, credentials, paths, or conversation history.

Equivalent shape:

```text
[TASK_CHAT_ADMISSION][<admission_id>]
MISSION: <mission_id>
TASK: <task_id>
ROLE: Bound ChatGPT advisory/report channel for this durable Task lineage.
NOTE: Execution authority remains with the local system. Later REPORT/CONSULT messages will use this exact conversation.
```

Persist the seed hash, not an additional durable copy of arbitrary prompt text.

Admission success requires exact posted-user-turn acknowledgement. It does not require waiting for the seed assistant reply.

## Durable admission state

Add a generic runtime-owned admission store separate from the immutable checkpoint journal and separate from canonical EPHEMERA Mission JSON.

Suggested default root:

```text
%LOCALAPPDATA%/ChatGPTMCPProbe/task-chat-admissions-v1
```

Required lifecycle:

```text
ABSENT
  -> RESERVED
  -> SEND_INTENT
  -> ACKED
  -> BOUND
```

Terminal/problem states:

- `FAILED_PRE_SEND`: failure proven to occur before any external send attempt; no ChatGPT conversation side effect is possible.
- `ADMISSION_UNKNOWN`: an external send may have occurred but exact acknowledgement/binding was not durably captured.
- `CONFLICT`: the same Task identity is presented with incompatible immutable admission parameters.

Semantics:

1. Persist `RESERVED` before browser mutation.
2. Persist `SEND_INTENT` immediately before the first operation that can create/send the seed.
3. After exact user-turn acknowledgement and canonical URL readback, persist `ACKED` with the exact URL + conversation id.
4. Derive the normal `TaskChatBinding` from `ACKED` and persist `BOUND`.
5. A crash after `ACKED` must be recoverable to `BOUND` without another send.
6. A surviving `SEND_INTENT` without durable ACK evidence is ambiguous. Do not create another conversation automatically.
7. A `BOUND` replay returns the existing binding and performs zero external sends.

Use exclusive create / atomic replacement semantics appropriate to the existing codebase. Parallel callers for the same Task must not create two conversations.

## External-side-effect policy

Conversation creation is an external side effect. Apply the same no-blind-retry posture already used by relay transport.

- pre-send failure proven before `SEND_INTENT` may be retried safely;
- after `SEND_INTENT`, uncertainty is not retry authority;
- `ADMISSION_UNKNOWN` must be inspectable;
- do not resolve uncertainty by creating a second conversation;
- do not switch to current chat, another open tab, a registry default, or another project.

A later reconciliation feature may recover an ambiguous seed by exact admission token, but it is not required to make the first implementation usable. Do not fake successful reconciliation in v1.

## Provisioning context

v1 must not depend on ambient `sessionState.currentProjectUrl`, browser focus, or a previously selected project.

The minimum accepted v1 path creates the fresh conversation from canonical ChatGPT home. Project-scoped automatic creation may be added later behind an explicit exact provisioning context; it is not required for this Task and must not become an ambient fallback.

Existing explicit/manual target admission remains supported unchanged.

## First-class surfaces

Implement a reusable core plus a thin MCP surface.

Minimum MCP operations:

- `task_chat_admit`
  - input: `mission_id`, `task_id`
  - output: admission state + immutable `TaskChatBinding`
  - idempotent after BOUND
- `task_chat_admission_status`
  - input: `mission_id`, `task_id`
  - read-only
  - exposes phase, admission id, binding identity when known, and ambiguity/failure classification

Do not make the model pass a target URL to `task_chat_admit`.

For first usable Dev Exec integration, extend Closed Goal Loop admission with an explicit automatic mode equivalent to:

```text
devexec closed-loop admit ... --auto-chat
```

Rules:

- `--auto-chat` and `--chat-url` are mutually exclusive.
- Existing `--chat-url` behavior remains backward compatible.
- `--auto-chat` obtains the TaskChatBinding from the admission primitive and then persists the existing Closed Goal Loop admission.
- no current-chat/default fallback is introduced.
- replaying the same Closed Goal Loop Task must reuse the same TaskChatBinding and must not seed another chat.

Do not silently change all existing CLI admissions to auto-create conversations in this slice. Prove the explicit automatic lane first.

## Likely implementation touchpoints

Prefer the smallest coherent change. Expected surfaces are:

- new generic core: `tools/devexec-task-chat-admission.mjs`
- focused tests: `tools/devexec-task-chat-admission.test.mjs`
- ChatGPT browser primitive in `src/chatgpt.ts` that can:
  - navigate to a fresh deterministic home conversation surface;
  - send exactly one seed through the existing fail-closed submit contract;
  - return exact USER_TURN_ACK plus canonical URL / conversation id;
  - avoid assistant-response dependency.
- MCP registration module, e.g. `src/task-chat-admission-tools.ts`, registered from `src/index.ts`
- `tools/devexec-closed-loop-facade.mjs`
- `tools/devexec-closed-loop-cli.mjs`
- `tools/devexec.mjs` usage text if needed
- `docs/DEVEXEC_CLOSED_LOOP_RUNBOOK.md` / `docs/README.md` only for the final public operating surface

These filenames are a starting map, not permission to duplicate existing abstractions. Fresh-read before editing.

## Implementation ordering

Use local prerequisites before creating an external chat.

For Closed Goal Loop auto-admission, validate as much as safely possible first: task/thread identity, runtime path/capability, worktree, argument shape, and other local fail-fast conditions. Provision the ChatGPT conversation only when the Task is otherwise admissible.

Once the external conversation exists, never discard it merely because a later local persistence step failed; reconcile from the durable Task-chat admission state.

## Acceptance — deterministic

The implementation is not done until focused tests prove at least:

1. same `mission_id + task_id` admitted twice -> same binding, exactly one seed send;
2. a different `task_id` -> different admission identity and a different provisioned conversation;
3. captured canonical URL and `conversation_id` agree with the existing strict parser;
4. a BOUND replay does not consult browser focus, current chat, registry default, or project state;
5. concurrent same-Task admission cannot create two chats;
6. pre-send failure becomes safely retryable `FAILED_PRE_SEND`;
7. failure/uncertainty after `SEND_INTENT` becomes `ADMISSION_UNKNOWN` and replay sends zero additional seeds;
8. durable `ACKED` can be completed to `BOUND` after restart with zero new send;
9. incompatible re-admission of an already claimed Task fails closed;
10. the generated binding is accepted by existing exact-target REPORT / CONSULT transport without a new binding schema;
11. Closed Goal Loop `--auto-chat` can persist an ordinary admission without `--chat-url`;
12. replaying that same Closed Goal Loop admission does not create a second chat;
13. existing explicit `--chat-url` admission semantics remain unchanged;
14. existing task-binding / relay / checkpoint regressions remain green.

Use proportional verification. Do not create an independent verifier framework for this Task.

## Real host acceptance

Because this changes external ChatGPT conversation-creation semantics, deterministic tests alone are not sufficient for FIRST_USABLE.

Run a disposable SHIRO-WS canary against the exact candidate:

### Task A

1. use a fresh non-production `mission_id + task_id`;
2. invoke automatic Task-chat admission with no manually supplied conversation URL;
3. prove exactly one new ChatGPT conversation was created;
4. prove seed delivery as `USER_TURN_ACK`;
5. prove returned canonical URL + conversation id form a valid `TaskChatBinding`;
6. invoke the same admission again and prove:
   - identical binding id;
   - identical conversation id;
   - zero additional seed sends;
7. send one harmless exact-bound REPORT through the produced binding and prove `USER_TURN_ACK`.

### Task B

1. admit a second fresh task id;
2. prove it receives a different conversation id from Task A;
3. prove Task A's binding remains unchanged.

No production Mission is mutated by the canary. Do not reuse an existing user conversation to make the canary pass.

## FIRST_USABLE

FIRST_USABLE is true when a caller can supply durable Task identity, request automatic admission, receive one immutable exact ChatGPT binding, replay safely, and use that binding for the existing exact-target relay without manually discovering or copying a URL.

Tests green without the real automatic browser flow do not by themselves satisfy FIRST_USABLE.

## Explicit non-goals

This Task does not:

- redesign `TaskChatBinding`;
- redesign checkpoint/report semantics;
- make ChatGPT Mission authority;
- implement fuzzy title/project target discovery (`DEV-CTR-001` remains separate);
- automatically rebind an active Task;
- create new Codex threads or change Codex continuation semantics;
- persist raw ChatGPT transcript as canonical state;
- implement EPHEMERA-System's consumer/adapter;
- implement reboot/service recovery beyond this admission journal;
- automatically delete canary conversations;
- make project-scoped creation a v1 blocker.

## EPHEMERA follow-up boundary

After this capability is live-qualified in `chatgpt-mcp`, the next Task is a thin EPHEMERA-System adapter:

```text
EPHEMERA Task admission
  -> request/reuse task_chat_admit(mission_id, task_id)
  -> retain binding reference as runtime/control-plane state
  -> Worker starts only after BOUND
  -> REPORT / CONSULT resolve only that frozen binding
```

Preserve the current EPHEMERA rule that raw ChatGPT URL / conversation id do not become canonical Mission semantic state. The adapter must not duplicate conversation provisioning or binding logic.

## Stop / block conditions

Stop the implementation lane, preserving exact state, if:

- the external seed result is ambiguous after send intent;
- the exact canonical conversation identity cannot be proven;
- a same-Task concurrent claim cannot be serialized safely;
- implementation would require weakening existing no-blind-resend or exact-target contracts;
- an unrelated active user conversation would need to be reused or mutated;
- an irreversible/external authority change beyond creating the disposable Task chat is required.

Ordinary implementation failures inside the authorized branch/worktree should be repaired autonomously.

## Completion evidence

Report only:

- candidate commit / branch;
- changed files;
- focused admission tests;
- relevant existing relay/checkpoint/CGL regression results;
- build / `git diff --check`;
- exact live-canary Task A/B results;
- whether FIRST_USABLE is satisfied;
- any unresolved `ADMISSION_UNKNOWN` or host blocker.

## Thin implementation mission

After this brief is committed, the executor prompt should remain small:

```text
Goal: Implement DEV-TCA-001 from docs/tasks/DEV-TCA-001-TASK-CHAT-ADMISSION.md so one durable Task lineage can automatically obtain and reuse one immutable ChatGPT conversation binding without manual URL setup.

Done: Deterministic acceptance in the Task Brief passes, Closed Goal Loop --auto-chat works while explicit --chat-url remains compatible, and the exact candidate passes the Task A/Task B SHIRO-WS live canary including replay with zero duplicate seed sends.

Constraints: Reuse TaskChatBinding and existing exact-target/no-blind-retry contracts. Do not redesign checkpoint relay, use ambient current-chat/default/project routing, auto-rebind active Tasks, or implement the EPHEMERA adapter in this Task.

Authority: Read the repo broadly and make ordinary in-repo branch edits/tests autonomously. The disposable ChatGPT canary conversations are authorized. Do not merge/release/deploy, mutate production Missions, delete user data, or change credentials/permissions.

Starting point: main@3bba7977b4cc7b338b6f1516e4e2c4adfb327cd2 and this Task Brief. Fresh-read README, docs/DEVEXEC_CLOSED_LOOP_RUNBOOK.md, docs/DEVEXEC_TASK_BOUND_CHAT_TARGET.md, tools/devexec-task-chat-binding.mjs, src/chatgpt.ts, and current tests before editing.

Evidence: Return candidate identity, changed files, relevant checks, exact live-canary evidence, FIRST_USABLE status, and only concrete blockers.
```
