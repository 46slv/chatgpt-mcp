# DEV-EVT-001 — Operator Event Ingress and Mission Routing

Status: PROPOSED / IMPLEMENTATION GOAL  
Scope: Dev Exec operator-facing request admission and exact Mission event attachment  
Parent architecture: [`../DEVEXEC_SELF_EVOLVING_ARCHITECTURE.md`](../DEVEXEC_SELF_EVOLVING_ARCHITECTURE.md)  
Design authority: [`../DEVEXEC_MISSION_INTERFACE_AND_OBSERVABILITY.md`](../DEVEXEC_MISSION_INTERFACE_AND_OBSERVABILITY.md)

> **Repository scope note:** This Goal belongs to Dev Exec as a system, not specifically to the ChatGPT MCP transport. It is colocated in `46slv/chatgpt-mcp` because this repository is currently the implementation home of Dev Exec.

## Goal

Provide one typed, durable, idempotent ingress path through which an operator or authorized caller can:

1. submit one new bounded `TASK` or `CONSULTATION` Request and receive an exact Mission identity;
2. attach new information to one exact existing Mission;
3. request a bounded Mission lifecycle transition;
4. receive one canonical terminal MissionResult after any required number of internal fresh Episodes.

The operator experience should remain:

```text
one Request in
  -> one durable Mission
  -> one verified MissionResult out
```

Internal agent count, role rotation, model selection, retries, and escalation remain replaceable implementation details.

## Problem

Dev Exec already has multiple execution paths and an architectural Event Spine, but an operator-facing contract is needed so autonomous work is not controlled by:

- appending text to whichever model session is currently alive;
- guessing a "current" Mission or most recent run;
- bypassing parent-owned state, authority, leases, or reconciliation;
- treating every intermediate agent response as a final answer;
- replaying an ambiguous submission or side effect.

A running autonomous-research Mission should receive new input as a typed Event appended to durable Mission state, not as unstructured conversation continuation.

## Core contract

### New Mission

```text
operator.request.submitted
  -> validation
  -> append-only Event receipt
  -> exact request_id / mission_id
  -> Mission admission or terminal rejection
```

Initial intents:

```text
TASK
CONSULTATION
```

`TASK` may request bounded side effects but cannot exceed the caller's existing authority or Dev Exec policy. `CONSULTATION` is read-only by default.

### Existing Mission

```text
operator.followup.submitted
  -> exact mission_id validation
  -> durable Event append
  -> safe-boundary reduction
  -> fresh next Episode sees updated state
```

There must be no unattended routing by UI focus, active process, most recent Mission, default alias, or human-facing title.

### Lifecycle requests

Candidate request events:

```text
mission.pause.requested
mission.resume.requested
mission.cancel.requested
```

These are parent-evaluated requests. They do not grant the UI or caller direct process-control authority.

## Non-negotiable invariants

1. Every accepted submission receives stable `event_id`, `request_id`, and idempotency identity.
2. New-Mission admission produces one exact `mission_id` or a terminal rejection; it never silently attaches to an existing Mission.
3. Existing-Mission follow-up requires the exact `mission_id`.
4. An Event is appended to the durable journal before it can affect Mission state.
5. Events do not directly mutate canonical state; a deterministic parent-owned reducer applies them.
6. A follow-up Event is never appended to the prompt or history of an already-running Episode.
7. The current Episode reaches a known boundary, or is cancelled and reconciled, before the Event becomes fresh reasoning input.
8. Context expansion implies context rotation: additional approved material is consumed only by a new Episode.
9. Duplicate submission does not create duplicate Mission work or duplicate side effects.
10. Ambiguous transport or side-effect delivery is reconciled, not blindly retried.
11. Event authority cannot exceed the caller, Mission, or current policy authority ceiling.
12. An Event for one Mission cannot be consumed by another Mission.
13. Mission continuity survives process restart without requiring discarded agent conversation.
14. Progress, Episode results, and submission receipts are distinct from the canonical terminal MissionResult.
15. Exactly one canonical terminal MissionResult identity is committed per Mission.
16. Local Model `RELAY`, Ephemeral Reasoner, Local Worker/executor, Verifier, and Codex Closed Goal Loop authorities remain distinct.

## Event lifecycle

A minimally useful Event lifecycle is:

```text
RECEIVED
  -> ACCEPTED
       -> DEFERRED
            -> APPLIED
       -> APPLIED
  -> DUPLICATE
  -> REJECTED
  -> BLOCKED
```

The exact state names may evolve, but the following distinctions must remain visible:

- durable admission versus application to Mission state;
- deferred safe-boundary application versus rejection;
- duplicate/no-replay versus fresh work;
- policy/authority blocker versus malformed input;
- accepted cancellation request versus proven child termination and reconciliation.

## Safe-boundary semantics

Normal follow-up handling:

```text
1. validate envelope and exact Mission identity
2. append immutable Event and receipt
3. preserve current Episode input snapshot
4. wait for Episode terminal or request bounded cancellation
5. reconcile tests, repository state, external effects, and pending actions
6. reduce Event into the next Mission snapshot
7. materialize role-specific bounded context
8. launch a fresh Episode
9. record Event application and consuming transition
```

An implementation may optimize idle or not-yet-started cases, but it must not mutate the input of an Episode after that Episode has begun.

## Proposed protocol surfaces

Exact schemas are an implementation task, but the Goal expects versioned typed contracts for at least:

```text
devexec.operator-event
devexec.event-receipt
devexec.mission-submission-receipt
devexec.mission-result
```

The envelopes should include, as appropriate:

- schema version;
- event/request/Mission identity;
- source and binding identity;
- idempotency key;
- intent;
- requested authority class;
- immutable payload reference/digest;
- correlation identity;
- occurrence and committed timestamps;
- acceptance/application/terminal status;
- reason code and bounded human-readable explanation;
- evidence and result references.

Large or sensitive request payloads remain outside the append-only Event row and are referenced by digest and runtime-owned location.

## MissionResult semantics

One Mission may contain many internal Episode outcomes. They must reduce to one canonical terminal MissionResult.

Candidate terminal statuses:

```text
COMPLETE
BLOCKED
NEEDS_HUMAN
CANCELLED
FAILED
```

The MissionResult should include:

- request and Mission identity;
- terminal status and result identity;
- bounded final summary or answer;
- changed surface where relevant;
- deterministic evidence references;
- unresolved limitations or human action needed;
- bounded aggregate Episode/runtime statistics;
- completion timestamp.

It must not require raw chain-of-thought, complete prompts, complete provider traffic, credentials, or full tool transcripts.

Duplicate completion attempts return or reference the committed canonical result rather than creating a second final answer.

## Relationship to DEV-LER-001

`DEV-LER-001` owns fresh bounded reasoning episodes and durable reasoning continuity.

This Goal owns the operator-facing boundary around those episodes:

```text
Operator Event
  -> Mission state transition
  -> fresh DEV-LER-001 Episode(s)
  -> verified terminal MissionResult
```

This Goal must not make the Ephemeral Reasoner responsible for admission, idempotency, routing, event ordering, authority, or terminal result identity.

## Relationship to current Dev Exec modes

The ingress should route through current capabilities rather than duplicate them.

Possible downstream paths include:

- deterministic Reflex decision;
- typed Skill or Local Worker execution;
- fresh Local Ephemeral Reasoning;
- exact Codex Closed Goal Loop;
- bounded ChatGPT consultation or supervision;
- explicit `NEEDS_HUMAN`.

Existing exact task/chat/thread/runtime bindings and no-replay behavior remain authoritative when those paths are selected.

## v0 implementation boundary

Keep v0 narrow.

Required:

- one new-Mission submission path;
- `TASK` and `CONSULTATION` intent distinction;
- one exact-existing-Mission follow-up path;
- append-only Event persistence;
- deterministic validation and reduction;
- idempotency and duplicate receipts;
- safe-boundary fresh-Episode application;
- restart/resume from durable state;
- one canonical terminal MissionResult;
- bounded structured logs and evidence;
- explicit blocked and human-intervention outcomes.

Optional after the core proof:

- pause/resume/cancel request events;
- priority changes;
- scheduling windows;
- attachments through immutable payload references;
- result delivery to multiple presentation adapters;
- Mission templates.

Implementation language, storage engine, transport, and final UI are not fixed by this Goal.

## v0 acceptance

A real bounded end-to-end test must prove at least:

1. A valid new `TASK` Request creates exactly one Event and one exact Mission.
2. A valid new `CONSULTATION` Request creates exactly one read-only Mission.
3. Duplicate submission with the same idempotency identity does not create a second Mission or repeat work.
4. Malformed, oversized, unsupported-version, or authority-contradicting Requests fail before Mission side effects.
5. An existing-Mission follow-up without exact `mission_id` is rejected.
6. A follow-up for Mission A cannot affect Mission B under concurrency.
7. A follow-up accepted during an active Episode does not change that Episode's input snapshot.
8. The follow-up is visible as deferred until a safe boundary is reached.
9. The next consuming Episode starts fresh and receives only the approved role projection of the updated state.
10. At least one Mission spans multiple fresh Episodes before completion.
11. Process restart between Event admission and Event application preserves no-replay and exact Mission routing.
12. An ambiguous pending side effect blocks unsafe application/replay and produces an explicit terminal or reconciliation state.
13. A completed Mission exposes exactly one canonical MissionResult even if completion is observed or requested more than once.
14. Submission receipt, progress/event stream, Episode outputs, and MissionResult are mechanically distinguishable.
15. The final result contains deterministic evidence references required by the Mission's acceptance criteria.
16. Raw reasoning transcript is not required to resume, verify, or return the MissionResult.
17. Existing Local Worker, RELAY, recovery/lease, and Codex Closed Goal Loop regression suites remain intact.

## Observability requirements

Before this Goal is considered operationally usable, the current Event and Mission state must be queryable by the `DEV-OBS-001` surface or an equivalent structured inspection path.

At minimum an operator must be able to see:

- received/accepted/deferred/applied/rejected/duplicate status;
- exact Mission identity;
- current safe-boundary reason;
- current Episode identity and role if any;
- terminal MissionResult identity/status if committed;
- blocker/reason code without reading raw internal files.

## Failure and stop conditions

Stop or require stronger authority when:

- Mission identity is absent, ambiguous, drifted, or mismatched;
- event schema/version or source identity is invalid;
- requested authority exceeds policy;
- a pending or ambiguous side effect cannot be reconciled;
- cancellation outcome cannot be proven;
- repeated application attempts show the same no-progress fingerprint;
- durable Event/Mission/result state cannot be written atomically;
- terminal result conflict is detected;
- configured budget, deadline, or resource limit is exhausted.

## Non-goals

This Goal does not authorize:

- arbitrary chat continuation as Mission state;
- direct injection into an in-flight model session;
- implicit current/most-recent Mission routing;
- unrestricted attachments or secret persistence;
- a second Mission launch path inside the GUI;
- direct UI process spawn/kill;
- multiple conflicting final answers for one Mission;
- automatic authority expansion from operator prose;
- blind retry after ambiguous delivery;
- one immortal supervisor agent;
- exposing chain-of-thought;
- replacing Dev Exec's existing execution, verification, binding, lease, or recovery machinery.

## Success condition

An operator can submit one task or consultation, allow Dev Exec to use any bounded number of replaceable internal Episodes and execution backends, and receive one verified terminal result. The same operator can add a new event to one exact running autonomous Mission without mutating an active agent context or weakening no-replay, authority, and verification boundaries.
