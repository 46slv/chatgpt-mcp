# DEV-OBS-001 — Mission Observatory and Runtime Status Surface

Status: PROPOSED / IMPLEMENTATION GOAL  
Scope: read-only human-facing Mission, Episode, runtime/model, evidence, resource, and log observability  
Parent architecture: [`../DEVEXEC_SELF_EVOLVING_ARCHITECTURE.md`](../DEVEXEC_SELF_EVOLVING_ARCHITECTURE.md)  
Design authority: [`../DEVEXEC_MISSION_INTERFACE_AND_OBSERVABILITY.md`](../DEVEXEC_MISSION_INTERFACE_AND_OBSERVABILITY.md)

> **Repository scope note:** This Goal belongs to Dev Exec as a system, not specifically to the ChatGPT MCP transport. It is colocated in `46slv/chatgpt-mcp` because this repository is currently the implementation home of Dev Exec.

## Goal

Provide one local human-readable surface that shows what Dev Exec is doing now, what it did recently, which runtime/model is actually active, why state changed, what evidence exists, and whether an autonomous Mission remains aligned with its Goal.

The first implementation is a **read-only Mission Observatory**. It projects canonical state and evidence but does not own Mission persistence, routing, authority, process lifecycle, or side effects.

The operator should be able to answer from one screen:

```text
What Mission is running?
What is its Goal and current verified state?
What Episode/role is active?
Which model/runtime is actually serving it?
What events are waiting or were applied?
What changed, what passed, what failed, and why?
Has context really rotated between Episodes?
What final result or blocker exists?
```

## Problem

Current Dev Exec components already produce useful state and evidence, including runtime/provider identity, Local Run Ledger records, resource samples, leases, recovery state, tests, and closed-loop receipts. Without one coherent projection, however, an operator must inspect separate JSON files, terminal output, provider UI, and repository records to understand the current system.

This becomes inadequate once one externally simple Request can internally span many disposable Episodes, multiple models, independent verification, safe-boundary event deferral, and occasional escalation.

The solution is not another autonomous controller. It is a thin, truthful projection over the existing Control Plane.

## Core architecture

Recommended authority chain:

```text
runtime-owned state / Event journal / ledgers / evidence / provider health
  -> Control Service
  -> loopback-only same-origin Control Server
  -> browser Mission Observatory
```

The UI reads normalized typed responses from the Control Server. It must not read or mutate Mission files directly.

A future interactive console may add buttons, but every state-changing action must submit a typed Operator Event through `DEV-EVT-001`. No browser control directly starts a model, spawns a process, edits canonical state, queues Codex, retries an action, or changes Mission authority.

## Required views

### 1. Mission list and selected Mission

Show at least:

- `mission_id` and bounded human-readable label;
- Goal and acceptance summary;
- Mission status;
- creation/start/update/terminal timestamps;
- current priority or scheduling class if defined;
- authority and side-effect ceiling;
- current verified progress summary;
- pending blocker, escalation, or human action;
- canonical MissionResult status and identity if committed.

Candidate Mission states include:

```text
ADMITTED
RUNNING
WAITING_EVENT
WAITING_RESOURCE
WAITING_SAFE_BOUNDARY
VERIFYING
PAUSED
BLOCKED
NEEDS_HUMAN
COMPLETE
CANCELLED
FAILED
UNKNOWN
```

The exact enum may evolve, but incomplete, blocked, complete, paused, cancelled, failed, and unknown states must remain mechanically distinguishable.

### 2. Current and recent Episodes

Show at least:

- `episode_id`;
- Mission and Run identity;
- role/class;
- state and lifecycle timestamps;
- runtime/provider/logical model identity;
- bounded context budget and materialized input size where available;
- working-set/evidence reference counts without leaking sensitive paths;
- tool-call, token, and timing metrics where available;
- outcome and reason/failure code;
- verifier relationship;
- whether context/session state was forwarded to the next Episode.

For the current Local Ephemeral Reasoning target, roles include:

```text
FIND
SOLVE
VERIFY
GOAL_CHECK
```

Future execution/audit/goal-alignment role shapes may be displayed without changing the Mission interface.

### 3. Event Spine and Mission Inbox

Show operator and system Events with:

- event kind and id;
- exact Mission subject;
- committed timestamp;
- source class;
- `RECEIVED`, `ACCEPTED`, `DEFERRED`, `APPLIED`, `DUPLICATE`, `REJECTED`, or `BLOCKED` state;
- safe-boundary reason;
- consuming state transition or Episode if applied;
- bounded reason code;
- idempotency/no-replay outcome;
- payload digest/reference, not raw sensitive payload by default.

An event accepted during an active Episode should visibly remain `DEFERRED` until it is applied through a new state projection.

### 4. Runtime and model status

Do not display one ambiguous model name. Distinguish:

```text
configured_model
selected_model
loaded_model
active_episode_model
available_models
```

Definitions:

- `configured_model`: runtime configuration requested by the current Mission or adapter.
- `selected_model`: current routing decision.
- `loaded_model`: model positively observed from provider control/readiness state.
- `active_episode_model`: model attributed to the active Episode receipt.
- `available_models`: models advertised as available but not necessarily loaded or selected.

The UI must show explicit values such as `UNKNOWN`, `NOT_SELECTED`, `NOT_LOADED`, `UNAVAILABLE`, `MISMATCH`, or `STALE` rather than inferring identity from an old run or a configured path.

Provider control health and served-model discovery are separate observations. A stale serving endpoint must not override an authoritative control failure, malformed state, or stopping state.

Show at least:

- runtime and provider;
- logical model identity;
- provider ownership (`PARENT`, `ADAPTER`, `EXTERNAL`, `UNKNOWN`) where known;
- lifecycle state (`READY`, `LOADING`, `STOPPED`, `FAILED`, `UNAVAILABLE`, etc.);
- device index and lease state where safe;
- control/serve reachability without exposing sensitive URLs unnecessarily;
- last positive health timestamp and staleness;
- configured-versus-loaded mismatch;
- cancellation and cleanup state.

### 5. Resources and performance

Reuse parent-owned measurements where available.

Show current or recent:

- GPU utilization;
- VRAM used;
- parent RAM;
- before/peak/after values for completed runs;
- wall time;
- first-tool latency;
- tool-call count;
- prompt/completion/total token counts;
- test wall time and exit state;
- resource availability/collection state.

Do not fabricate missing telemetry. Display `NOT_COLLECTED` or `UNAVAILABLE` with the reason/source.

### 6. Evidence and verification

Show at least:

- changed-path count and bounded safe path projection;
- diff/evidence digest;
- test status/count/exit state;
- verifier status and reason codes;
- base drift and unexpected commit detection;
- failure fingerprint and progress delta;
- pending or ambiguous side-effect state;
- exact result/evidence references;
- whether an outcome is self-reported, parent-measured, provider-reported, or independently verified.

A Solver's `DONE` text must not appear as equivalent to verified problem `SOLVED` or Mission `COMPLETE`.

### 7. Structured live log

Provide a time-ordered bounded stream containing safe metadata:

- timestamp;
- Mission / Run / Episode / Event identity;
- lifecycle transition;
- role;
- runtime/provider/logical model id;
- tool name and result class where safe;
- test/evidence state;
- reason/failure codes;
- resource/token/timing measurements where available;
- redaction and truncation markers.

Filtering should support at least Mission, Episode, event kind, model/runtime, status, and time range.

## Ephemeral-context proof

The Observatory is part of the verification surface for the Ephemeral Agents architecture.

For each completed Episode, it should be possible to inspect structured facts such as:

```text
episode_id: ...
context_mode: FRESH
conversation_history_forwarded: false
raw_reasoning_canonical: false
terminal_state: COMPLETED
next_episode_id: ...
next_episode_started_fresh: true
```

The exact representation may differ, but the UI must not merely label an Episode "fresh" based on configuration. It should project parent-owned lifecycle receipts or equivalent evidence.

This proves semantic context rotation. It does not claim secure physical zeroization of GPU/OS/provider memory.

## Source-of-truth precedence

The Observatory must resolve conflicts in this order:

```text
1. current durable Mission/Event/Episode state
2. exact bindings, leases, recovery, and pending-action records
3. provider control health and served-model observation
4. parent-measured run/evidence/resource records
5. current repository/runtime/test evidence
6. historical completed ledgers
7. human-readable summaries
```

Old logs, stale UI cache, configured model names, and agent prose cannot override current authoritative state.

Every displayed field should retain or expose a source class and observation timestamp where ambiguity matters.

## Read-only authority boundary

The v0 UI and its static assets must contain no implementation of:

- Mission persistence reads from arbitrary local paths;
- Mission state reduction;
- authority or safe-boundary derivation;
- direct child process spawn or termination;
- provider start/stop;
- repository mutation;
- Codex queue/resume;
- ChatGPT send/retry;
- lease acquisition/release;
- recovery reconciliation;
- action replay;
- credential, cookie, or token handling.

Those capabilities remain in typed server-side services and existing adapters.

The browser may request normalized read models. A later state-changing UI action must call the same `DEV-EVT-001` ingress used by other callers and display the resulting durable receipt.

## Transport and exposure boundary

The local Observatory should:

- bind only to loopback by default;
- use one same-origin Control Server for UI assets and API calls;
- reject non-loopback bind unless a separate authenticated remote-access design is approved;
- avoid placing secrets, real ChatGPT URLs, credentials, or full filesystem paths in browser-visible state;
- apply response size, item count, time range, and log line bounds;
- expose explicit health/staleness rather than hanging indefinitely;
- remain usable after a runtime child crashes because canonical state is parent-owned.

TLS, remote access, multi-user identity, and external publication are outside v0.

## Privacy, redaction, and retention

Default Observatory data must exclude:

- raw chain-of-thought;
- complete hidden prompts;
- complete provider responses;
- credentials, API keys, cookies, authorization headers;
- browser profile/session state;
- unrestricted stdout/stderr dumps;
- sensitive payload bodies;
- full local model paths when a logical model id is sufficient;
- unrelated process enumeration;
- unrelated repository or user paths.

Structured logs should use bounded fields, logical identities, digests, reason codes, and evidence references.

A future diagnostic capture mode must be explicit, time-bounded, access-bounded, redacted, and separately retained. It must not silently become canonical Mission memory.

## Proposed read models

Exact schemas are an implementation task, but versioned responses should cover at least:

```text
devexec.observatory.overview
devexec.observatory.mission-snapshot
devexec.observatory.episode-list
devexec.observatory.event-list
devexec.observatory.runtime-status
devexec.observatory.evidence-summary
devexec.observatory.log-page
```

Each response should include:

- schema version;
- generated/observed timestamp;
- source/reducer version where relevant;
- freshness/staleness state;
- bounded pagination or continuation identity;
- explicit availability/error fields;
- no unknown-field tolerance where it would hide schema drift.

Live refresh may use bounded polling, Server-Sent Events, WebSocket, or another local mechanism. The Goal does not fix the transport as long as restart, ordering, backpressure, and bounded memory behavior are proven.

## v0 implementation boundary

Required v0 surface:

```text
Overview
Missions
Selected Mission
Current/recent Episodes
Event states
Runtime/model health
Resources
Evidence/tests
Structured logs
```

Required server behavior:

- loopback-only Control Server;
- same-origin UI and API;
- normalized typed read models;
- bounded query sizes and timeouts;
- explicit unavailable/stale states;
- restart-safe reads from canonical runtime records;
- no state-changing endpoint required for v0.

Required operator usability:

- one command or existing Dev Exec service start exposes the Observatory;
- current loaded/active model can be identified without opening provider-specific UIs;
- a blocked Mission shows the blocker and required next authority/action;
- recent completed runs remain inspectable without reading raw JSON manually;
- fresh Episode rotation is visible from structured lifecycle evidence.

Visual design, frontend framework, chart library, permanent URL, remote access, and final product naming remain open.

## v0 acceptance

A real local proof must demonstrate at least:

1. The server binds only to `127.0.0.1`/loopback under default configuration.
2. The browser UI and APIs are served from the same local origin.
3. The UI contains no direct process-spawn, Mission-persistence, reducer, provider-lifecycle, repository-write, or action-replay implementation.
4. The Control Service returns one versioned bounded overview without scraping terminal prose.
5. At least one active and one completed Mission can be distinguished.
6. The selected Mission shows exact Mission identity, Goal summary, state, current Episode, and terminal result state.
7. At least ten completed fresh Episodes can be inspected without requiring their raw conversations.
8. Episode lifecycle evidence shows that conversation/reasoning history was not forwarded between adjacent Episodes.
9. An accepted follow-up Event is shown as deferred during an active Episode and applied only at a later fresh boundary.
10. Duplicate Event submission is visibly classified without duplicate work.
11. Configured, selected, loaded, and active-Episode model identities are separately represented.
12. A configured/loaded mismatch or unavailable provider is shown explicitly rather than hidden by stale data.
13. Provider control failure cannot be masked by a stale served-model response.
14. Current or recent RAM/VRAM/GPU measurements expose availability and before/peak/after semantics where supported.
15. Current/recent run metrics preserve source attribution such as parent-measured, harness-reported, adapter-reported, or provider usage.
16. Tests, verifier outcome, evidence digest, base drift, and ambiguous-action state are visible for a representative run.
17. Structured logs remain bounded and redact prohibited sensitive fields.
18. Missing or malformed underlying state produces an explicit degraded/error view rather than fabricated healthy state.
19. Browser refresh or server restart reconstructs the same canonical Mission/Event/Episode status.
20. Multiple Missions do not cross-contaminate events, logs, runtime attribution, or terminal results.
21. Observatory failure does not corrupt, stop, or rewrite canonical Mission execution.
22. Existing Local Worker, provider lease/recovery, run-ledger, and Codex Closed Goal Loop tests remain intact.

## Future interactive controls

After `DEV-EVT-001` is implemented and independently tested, the Observatory may add:

```text
Submit Task
Submit Consultation
Add Follow-up Event
Pause
Resume
Cancel
```

Every control must:

1. create a versioned typed request;
2. call the Control Service/Event ingress;
3. receive a durable receipt;
4. display accepted/deferred/rejected/duplicate state;
5. never infer success from the HTTP response alone when a later side effect is required;
6. never replay an ambiguous operation automatically.

Controls are therefore a view/controller adapter over the Event Spine, not an alternative control path.

## Failure and stop conditions

The implementation must fail closed or degrade explicitly when:

- Mission/Event/Episode schemas are unsupported or inconsistent;
- reducer/source versions drift beyond compatibility;
- provider identity cannot be proven;
- timestamps or state appear stale;
- a lease/recovery/pending-action conflict exists;
- response/log bounds would be exceeded;
- sensitive fields cannot be safely redacted;
- non-loopback exposure is requested without an approved security design;
- current state cannot be distinguished from historical state;
- the UI would need direct filesystem/process authority to satisfy a feature.

## Non-goals

This Goal does not require or authorize:

- a second Control Plane;
- direct UI state mutation or child launch;
- remote/public dashboard exposure;
- raw chain-of-thought display;
- unrestricted prompt/response capture;
- monitoring unrelated processes or files;
- inferring the active model solely from configuration or VRAM use;
- trusting agent self-report as verification;
- replacing canonical event/ledger/evidence stores with browser state;
- selecting the final visual design or frontend stack;
- implementing all future interactive controls in v0;
- changing existing Mission, Local Worker, RELAY, Codex, lease, recovery, or verification authority boundaries.

## Success condition

An operator can open one local screen and accurately understand Dev Exec's current and recent autonomous activity, including the actual active model, Mission Goal, short-lived Episode rotation, newly submitted Events, resource use, verification state, blockers, and final result. The screen remains a bounded projection of canonical evidence and cannot bypass the system it observes.
