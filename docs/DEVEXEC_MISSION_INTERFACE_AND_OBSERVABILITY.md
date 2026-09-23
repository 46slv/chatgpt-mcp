# Dev Exec — Mission Interface, Event Ingress, and Observatory

Status: PROPOSED / DESIGN AUTHORITY  
Last updated: 2026-09-03 JST  
Scope: operator-facing Mission ingress, typed event attachment, single-result semantics, and human-readable runtime observability  
Reviewed base: `main` at `7b65b1311b064414d5340337a0fe896e2d8f4fb6`

> **Implementation status note:** This document defines a target interface and its invariants. It does not claim that the complete ingress, Mission-result, or Observatory surface is implemented at the reviewed base.

> **Repository scope note:** This design belongs to Dev Exec as a system, not specifically to the ChatGPT MCP transport. It is colocated in `46slv/chatgpt-mcp` because this repository is currently the implementation home of Dev Exec.

Parent architecture:

- [`DEVEXEC_SELF_EVOLVING_ARCHITECTURE.md`](DEVEXEC_SELF_EVOLVING_ARCHITECTURE.md)
- [`goals/DEV-LER-001-LOCAL-EPHEMERAL-REASONING.md`](goals/DEV-LER-001-LOCAL-EPHEMERAL-REASONING.md)

Implementation Goals introduced by this design:

- [`goals/DEV-EVT-001-OPERATOR-EVENT-INGRESS.md`](goals/DEV-EVT-001-OPERATOR-EVENT-INGRESS.md)
- [`goals/DEV-OBS-001-MISSION-OBSERVATORY.md`](goals/DEV-OBS-001-MISSION-OBSERVATORY.md)

## 0. Executive summary

The intended operator experience is simple even when the internal execution is not:

```text
one external Request
  -> one durable Mission
  -> any bounded number of disposable reasoning/execution Episodes
  -> one canonical verified MissionResult
```

A task or consultation may therefore look like one request and one answer from outside while Dev Exec internally launches, completes, discards, and replaces multiple agents or role episodes. Agent count, role topology, model choice, retries, and escalation are internal implementation details unless they are required as evidence or diagnostics.

A running autonomous-research Mission may also receive new operator input. The correct operation is not to inject text directly into whichever model session happens to be active. It is:

> append a typed Operator Event to the exact Mission's Event Spine, reduce it into durable Mission state at a safe boundary, then launch a fresh Episode from the updated state.

The human-facing status surface is the **Mission Observatory**. It projects canonical runtime state, active and historical Episode state, actual runtime/model health, resource use, event routing, evidence, and structured logs. It is not a second Control Plane.

## 1. Terms and ownership

### Request

One external submission by an operator or authorized caller. Initial request intents are:

- `TASK`: bounded execution or mutation may be requested, subject to existing authority and verification rules.
- `CONSULTATION`: read-only analysis and a final answer are requested by default.

A Request receives a stable `request_id` and idempotency identity.

### Mission

The durable unit of purpose owned by Dev Exec. It contains the Goal, acceptance, protected constraints, verified state, event history, evidence references, authority ceiling, and terminal result identity.

A Mission may outlive any process, model context, provider session, or individual Episode.

### Event

An immutable typed input appended to the Event Spine. An Event may create a Mission, add information to an exact existing Mission, request a lifecycle transition, or report an external/runtime observation.

Events do not directly mutate canonical Mission state. The parent validates, deduplicates, journals, and reduces them.

### Episode

One short-lived bounded reasoning, execution, or verification unit. The initial local reasoning mechanism uses fresh `FIND`, `SOLVE`, `VERIFY`, and `GOAL_CHECK` episodes. Future orchestration may use other role shapes while preserving the same ownership boundaries.

### MissionResult

The single canonical terminal result for one Mission. Progress notifications, acknowledgements, Episode outputs, and intermediate findings are not additional MissionResults.

### Mission Observatory

A human-readable projection of runtime-owned state and evidence. The Observatory may later expose controls, but every control must submit a typed Event through the same validated ingress path rather than directly mutating state or spawning work.

### Context discard

When an Episode ends, its conversation/session context and raw reasoning transcript are not forwarded to the next Episode and are not required to reconstruct Mission continuity.

This is the guaranteed semantic meaning. The word "purge" must not be used to imply secure physical zeroization of provider memory, GPU memory, operating-system pages, or remote service storage unless a separate security contract proves that behavior.

## 2. External contract: one Request, one MissionResult

The external contract must remain stable even if the internal agent architecture changes.

```text
submit(Request)
  -> SubmissionReceipt { request_id, mission_id, event_id, admission_status }

observe(mission_id)
  -> MissionSnapshot / Events / Evidence / Progress

complete(mission_id)
  -> exactly one canonical MissionResult
```

The submission receipt is not the final answer. It confirms durable admission or a terminal admission rejection.

For long-running Missions, transport may be asynchronous. This does not weaken the single-result rule: status updates and event streams remain projections, while one terminal MissionResult owns the final externally consumable answer.

### 2.1 New Mission submission

A new operator request should become a typed event such as:

```text
operator.request.submitted
```

The Kernel validates the request envelope, requested intent, payload bounds, authority ceiling, idempotency identity, and source identity before creating a Mission.

### 2.2 Existing Mission attachment

New information for an existing autonomous Mission should become:

```text
operator.followup.submitted
```

The caller must supply the exact `mission_id`. There must be no unattended fallback to "current Mission", most recent run, currently visible UI card, active process, or mutable default.

The Event is appended immediately after validation, but it becomes reasoning input only through a later role-specific state projection.

### 2.3 Lifecycle requests

Candidate lifecycle events are:

```text
mission.pause.requested
mission.resume.requested
mission.cancel.requested
```

These are requests to the parent Control Plane, not direct signals from the UI to an agent process. The parent decides whether to defer, cancel, reconcile, resume, reject, or require human intervention according to current side-effect state and authority.

## 3. Minimal Operator Event envelope

A production schema may evolve, but the semantics should resemble:

```json
{
  "protocol": "devexec.operator-event",
  "schema_version": 1,
  "event_id": "uuid",
  "idempotency_key": "caller-stable-key",
  "kind": "operator.followup.submitted",
  "occurred_at": "2026-09-03T16:00:00+09:00",
  "source": {
    "type": "operator",
    "adapter": "mission-console",
    "binding_id": "sha256:..."
  },
  "subject": {
    "mission_id": "mission-..."
  },
  "intent": "CONSULTATION",
  "requested_authority": "READ_ONLY",
  "payload_ref": {
    "sha256": "sha256:...",
    "location": "runtime-owned-reference"
  },
  "correlation_id": "..."
}
```

Large or sensitive payloads remain outside the journal record and are referenced by immutable digest and runtime-owned location. Redaction occurs before persistence where required.

Unknown fields, unsupported schema versions, invalid identities, excessive payloads, or authority contradictions fail closed.

## 4. Safe-boundary event application

An Operator Event must not be appended to the prompt/history of an already-running Episode.

Normal sequence:

```text
1. validate and journal Event
2. deduplicate by stable identity
3. mark Event ACCEPTED or REJECTED
4. allow the current bounded Episode to reach a known boundary
5. verify or reconcile any in-flight side effect
6. reduce accepted Event into canonical Mission state
7. materialize a new role-specific context projection
8. start a fresh Episode
9. mark Event APPLIED with the consuming state transition
```

Possible Event routing states include:

```text
ACCEPTED
DEFERRED
APPLIED
REJECTED
DUPLICATE
BLOCKED
```

An emergency cancellation may terminate the current child process, but the next step is reconciliation, not immediate blind replay. If the system cannot prove whether an external or repository side effect occurred, the Mission enters an explicit ambiguous or human-intervention state.

## 5. Internal execution remains replaceable

The initial Local Ephemeral Reasoning Goal defines:

```text
FIND -> SOLVE -> VERIFY -> GOAL_CHECK
```

This interface does not freeze that topology as the final orchestration design.

A later Mission may internally use, for example:

```text
execution / implementation
independent verification / audit
goal-alignment / anti-drift supervision
```

It may also route selected work to Local Models, Codex, Pi, ChatGPT, deterministic Reflex rules, or typed Skills. The external Request/Mission/MissionResult contract must not change merely because an adapter, model, role split, or scheduling policy changes.

Required internal invariants remain:

- Dev Exec owns Mission, routing, authority, durable state, event reduction, and terminal result identity.
- Harnesses own bounded Episode mechanics.
- Agents own temporary reasoning only.
- Executors own bounded side effects.
- Verifiers own acceptance evidence.
- Goal completion and one solved subproblem remain distinct.
- Agent self-report alone cannot complete a Mission.
- Raw chain-of-thought is not canonical state and is not required for operator observability.

## 6. Canonical MissionResult

A Mission may emit many Episode results but only one canonical terminal MissionResult.

Candidate terminal statuses:

```text
COMPLETE
BLOCKED
NEEDS_HUMAN
CANCELLED
FAILED
```

A MissionResult should contain only bounded, externally useful material:

```json
{
  "protocol": "devexec.mission-result",
  "schema_version": 1,
  "request_id": "request-...",
  "mission_id": "mission-...",
  "result_id": "sha256:...",
  "status": "COMPLETE",
  "summary": "bounded human-readable result",
  "changed_surface": [],
  "evidence_refs": [],
  "remaining_limits": [],
  "episode_aggregate": {
    "episode_count": 17,
    "runtime_classes": ["local", "codex"],
    "escalation_count": 1
  },
  "completed_at": "2026-09-03T16:30:00+09:00"
}
```

The exact internal prompt, hidden reasoning, complete raw tool history, credentials, runtime paths, and unredacted provider traffic must not be required in the result.

Terminal result creation must be idempotent. A duplicate completion path returns or references the already-committed result rather than generating a second conflicting answer.

## 7. Mission Observatory

The Observatory should answer, from one screen:

- What Missions exist and which one is active, blocked, complete, paused, or awaiting a safe boundary?
- What Goal and acceptance currently govern the selected Mission?
- Which Episode and role are running now?
- Which runtime/provider/model is actually serving that Episode?
- Which model was configured, selected, loaded, or merely available?
- What events are accepted, deferred, applied, rejected, or duplicated?
- What tests, diffs, verifier decisions, evidence, and failure fingerprints exist?
- What are current and recent GPU, VRAM, RAM, timing, token, and tool-call metrics?
- Why did the system stop, escalate, defer, or rotate context?

### 7.1 Model identity distinctions

The UI must not collapse these into one ambiguous "model" field:

```text
configured_model    requested configuration
selected_model      routing decision
loaded_model        provider health/readiness observation
active_episode_model model attributed to the running Episode
```

If any identity cannot be proven, show `UNKNOWN`, `NOT_LOADED`, `UNAVAILABLE`, or another explicit state rather than inferring from old logs.

### 7.2 Episode lifecycle distinctions

The Observatory should expose structured lifecycle facts such as:

```text
Episode #12 COMPLETED
context_forwarded: false
raw_transcript_canonical: false
next Episode #13 STARTED_FRESH
```

This proves the architectural boundary without displaying private reasoning.

### 7.3 Structured logs

Default logs should include bounded metadata:

- timestamp;
- event kind and event id;
- Mission / Run / Episode identity;
- role;
- runtime/provider/logical model id;
- lifecycle transition;
- tool name and status where safe;
- test/evidence status;
- token, latency, and resource metrics where available;
- reason and failure codes;
- redaction/truncation markers.

Raw prompts, raw responses, chain-of-thought, secrets, credentials, cookies, full browser state, and unnecessary filesystem paths are excluded by default. A future diagnostic capture mode requires an explicit retention, redaction, and access policy.

## 8. Observatory authority boundary

The first Observatory implementation should be read-only.

Recommended shape:

```text
runtime-owned state / event journal / ledgers / provider health
  -> Control Service
  -> loopback-only same-origin Control Server
  -> browser Observatory
```

The UI must not contain:

- direct Mission persistence access;
- state reducer logic;
- authority or safe-boundary derivation;
- process spawn or kill implementation;
- provider lifecycle ownership;
- direct repository mutation;
- direct action replay.

Future controls such as `Submit`, `Follow up`, `Pause`, `Resume`, or `Cancel` must call the typed Operator Event ingress. The Control Service remains responsible for validation, idempotency, journaling, state transition, and receipts.

## 9. Canonical data sources

The Observatory should project current source-of-truth records rather than scrape human prose.

Candidate sources include:

- Mission snapshots and state-reducer outputs;
- append-only Event journal;
- Episode manifests and lifecycle receipts;
- verifier and deterministic evidence records;
- current Local Run Ledger;
- provider/device/port leases;
- recovery journal and ambiguous-action state;
- runtime/provider control health;
- served-model discovery;
- parent-owned RAM/VRAM/GPU sampling;
- exact Codex/ChatGPT task bindings where relevant.

Repository documents define schema and invariant authority. Machine-specific live state, real URLs, credentials, leases, and large/sensitive evidence remain outside Git.

## 10. Concurrency and event ordering

Multiple Missions may run concurrently. Within one Mission, Event application must have a deterministic order based on committed journal identity, not browser timing or agent observation order.

Required behavior:

- duplicate idempotency keys do not create duplicate work;
- the same Event is never applied twice after restart;
- conflicting lifecycle requests produce an explicit state rather than arbitrary last-writer behavior;
- an Event for Mission A cannot be consumed by Mission B;
- a delayed UI response cannot overwrite fresher canonical state;
- an event accepted while an Episode runs is visible as `DEFERRED` until a safe transition applies it;
- an event with insufficient authority remains recorded as rejected/blocked evidence without expanding permissions.

## 11. v0 implementation boundary

Keep the first implementation narrow and reuse existing Dev Exec components.

### Event ingress v0

- typed new-Mission `TASK` and `CONSULTATION` submission;
- exact existing-Mission follow-up;
- append-only journal and idempotency receipt;
- safe-boundary reduction into a fresh Episode;
- canonical terminal MissionResult;
- explicit blocked and human-intervention outcomes.

### Observatory v0

- loopback-only read-only browser UI;
- Mission list and selected Mission snapshot;
- current/recent Episode lifecycle;
- runtime/provider/model identity and health;
- Event queue/application state;
- current/recent ledger, resources, tests, evidence, and failure reason;
- bounded live refresh through polling or a server-push mechanism;
- structured redacted logs;
- no direct controls beyond navigation/filtering.

Transport, database, frontend framework, visual design, and final product naming are intentionally not fixed here.

## 12. Implementation sequence

A reasonable order is:

```text
1. Event / MissionSnapshot / EpisodeRecord / MissionResult schemas
2. append-only Event journal and deterministic reducer boundary
3. read-only Control Service projections
4. loopback Observatory over current and historical state
5. new-Mission TASK / CONSULTATION ingress
6. exact Mission follow-up at safe Episode boundaries
7. pause / resume / cancel request events and reconciliation
8. terminal result delivery adapters
9. optional Observatory controls that submit the same typed Events
```

Observability is intentionally early. It provides evidence that context rotation, model selection, event deferral, verification, and terminal result semantics are working before more autonomy is granted.

## 13. Cross-goal acceptance principle

The combined feature is successful when a real bounded Mission proves:

```text
one submitted Request
  -> durable exact Mission identity
  -> multiple fresh disposable Episodes
  -> at least one visible safe-boundary Event attachment
  -> independently verified completion or explicit terminal blocker
  -> exactly one canonical MissionResult
```

At the same time, the Observatory must reconstruct the visible lifecycle from canonical records without depending on raw agent transcripts or becoming capable of bypassing the Control Plane.

## 14. Non-goals

This design does not require or authorize:

- one immortal agent session;
- direct prompt injection into an in-flight Episode;
- mutable "current Mission" routing;
- unrestricted multi-agent spawning;
- exposing chain-of-thought;
- treating progress events as multiple final answers;
- allowing a UI to own Mission state or process execution;
- automatic authority expansion from a follow-up message;
- blind retry after ambiguous side effects;
- secure-memory-zeroization claims without a separate proof;
- selecting a permanent final frontend, transport, database, or product name now;
- replacing the existing Codex Closed Goal Loop, Local Worker, RELAY, leases, recovery, or verification boundaries.

## 15. Relationship to existing authority

Current implemented behavior remains governed by live code/tests and current operational runbooks.

This document extends the target architecture by defining a stable human-facing contract around the existing principles:

- Dev Exec owns durable continuity and authority.
- Ephemeral agents own temporary reasoning.
- typed Events initiate or alter autonomous work.
- Mission state, not agent conversation, carries continuity.
- one Mission exposes one canonical verified terminal result.
- observability is a projection of canonical evidence, not a source of authority.
