# F03 Mission lifecycle and three-axis governance

Status: implemented consumer contract; real model/provider execution remains an F04/F05 concern.

## Ownership

`tools/devexec-mission-controller.mjs` is a consumer of the existing public `DevExecMissionStore`. It does not create a second Mission store or journal.

All lifecycle, Episode, and Goal transitions are represented by the canonical source-owned Event Spine:

1. A create request is one `operator.request.submitted` Event.
2. A lifecycle/Episode/Goal command is one `operator.followup.submitted` Event.
3. A command remains `DEFERRED` until the controller applies it through the existing `FRESH_NEXT_EPISODE` seam.
4. Terminal completion uses the existing one-file, one-identity `MissionResult` implementation.
5. MissionStore schema/version and Event kinds are unchanged.

The controller stores only immutable, content-addressed command payloads and artifacts below the same configured state root. These are referenced by the canonical Events and are not a mutable status authority. `inspect()` rebuilds the control projection from the Event journal, verifies every referenced byte digest and exact Mission scope, then compares terminal status with the canonical MissionResult.

## Public facade

```js
import { DevExecMissionController } from "./tools/devexec-mission-controller.mjs";

const controller = new DevExecMissionController({
  stateDir,
  validateAuthority,
  verifyFreshContext,
});
```

`validateAuthority({ action, mission, actor, requested_authority })` is mandatory for every mutation. It must return `{ allowed: true, authority_ref }`. Absence, error, or any other response fails before an Event or command payload is written.

`verifyFreshContext({ mission, episode, actor })` is mandatory for `START_EPISODE`. It must verify the parent-owned fresh-context receipt and return `{ verified: true, receipt_sha256 }`. A payload flag alone never creates an active Episode or proves freshness.

The public methods are:

- `submit(request)`
- `control(command)` with `FOLLOWUP` for exact typed operator input
- `inspect(missionId)`
- `listMissions({ limit })`
- `listEvents(missionId, { after, limit })`
- `listEpisodes(missionId, { after, limit })`
- `result(missionId)`
- `writeArtifact({ missionId, kind, content })`
- `assertArtifact(ref, { missionId, kind })`

Every control command includes an exact `mission_id` and `expected_revision`. There is no current/latest/focused Mission resolver.

## Lifecycle

```text
CREATE -> CREATED
CREATED --START--> RUNNING
RUNNING --PAUSE at boundary--> PAUSED
PAUSED --RESUME--> RUNNING
CREATED|RUNNING|PAUSED --CANCEL at boundary--> CANCELLED + one MissionResult
RUNNING --COMPLETE after verified Goal--> COMPLETE + one MissionResult
```

Pause, cancel, and complete requested while an Episode is active remain durably `DEFERRED`. `COMPLETE_EPISODE` and the pending boundary control run under one Mission transition lock. A crash can leave an inspectable Event before the result projection is finalized; replay never starts a second Episode or commits a second result.

`FOLLOWUP` uses an immutable `FOLLOWUP_INPUT` artifact. During an active Episode it remains `DEFERRED`, does not change that Episode's input reference, and is reduced into `context_events` only when the Episode completes. The next Episode must bind the resulting new revision and snapshot hash.

Only one boundary control may be pending. A second one fails with `CONTROL_ALREADY_PENDING` rather than creating conflicting deferred authority.

## Three axes

| Axis | Roles | Authority |
| --- | --- | --- |
| `TASK_EXECUTION` | `WORKER`, `TASK_PLANNER` | Performs the assigned bounded Episode only. |
| `GOAL_CONTROL` | `TECHNICAL_VERIFIER`, `GOAL_CONTROLLER` | Produces independent evidence and advances the Goal. |
| `MISSION_GOVERNANCE` | `MISSION_GOVERNOR` | Starts/pauses/resumes/cancels/completes Missions and assigns Episodes. |
| `DETERMINISTIC` | `OPERATOR_INGRESS`, `CONTROL_REDUCER` | Admits typed input and rebuilds state; it is not a reasoning axis. |

`ADVANCE_GOAL` requires a completed `PASS` `TECHNICAL_VERIFIER` Episode. Its session and context fingerprint must differ from the prior Task Execution Episode. `COMPLETE` requires the exact verifier already recorded by the `COMPLETE` Goal transition. Worker output and process exit are never enough.

A `CONSULTATION` has a `READ_ONLY` ceiling. Every Episode records `execution_authority`, and `BOUNDED_WRITE` is rejected even when the actor text requests it.

## Episode evidence

`START_EPISODE` binds:

- exact Episode, Mission, axis, and role;
- current projection revision and snapshot hash;
- an immutable, Mission-scoped input reference;
- unique session and context fingerprints;
- a parent-owned fresh-context receipt;
- `history_forwarded: false`;
- execution authority, runtime class, and configured/selected/loaded model identities.

The projection reports an Episode as active only after the typed Event is `APPLIED`. It reports `freshness: PARENT_VERIFIED` only after the injected verifier accepts the receipt. Adjacent Episodes cannot reuse session or context identities.

## Request example

```json
{
  "protocol": "devexec.mission-request",
  "schema_version": 1,
  "event_id": "evt-example-create",
  "request_id": "req-example-create",
  "idempotency_key": "caller-stable-create-key",
  "occurred_at": "2026-09-08T01:00:00.000Z",
  "source": {
    "type": "operator",
    "adapter": "mission-cli",
    "binding_id": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "actor": {
    "binding_id": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "axis": "DETERMINISTIC",
    "role": "OPERATOR_INGRESS"
  },
  "intent": "TASK",
  "requested_authority": "BOUNDED_WRITE",
  "goal": {
    "goal_id": "goal-example",
    "summary": "Complete the bounded fixture",
    "acceptance_refs": ["spec:fixture-v1"],
    "protected_constraints": ["scope:fixture-only"]
  },
  "correlation_id": "corr-example-create"
}
```

## Start example

```json
{
  "protocol": "devexec.mission-command",
  "schema_version": 1,
  "event_id": "evt-example-start",
  "request_id": "req-example-start",
  "idempotency_key": "caller-stable-start-key",
  "occurred_at": "2026-09-08T01:01:00.000Z",
  "source": {
    "type": "operator",
    "adapter": "mission-cli",
    "binding_id": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "actor": {
    "binding_id": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "axis": "MISSION_GOVERNANCE",
    "role": "MISSION_GOVERNOR"
  },
  "mission_id": "mission-exact-id-from-submit",
  "expected_revision": 1,
  "action": "START",
  "data": { "reason": "accepted bounded execution" },
  "correlation_id": "corr-example-start"
}
```

## CLI

The existing root now dispatches:

```text
devexec mission submit --request <file|-> --json
devexec mission followup --event <file|-> --json
devexec mission control --command <file|-> --json
devexec mission reconcile --mission <exact-id> --json
devexec mission inspect --mission <exact-id> --json
devexec mission wait --mission <exact-id> --until <terminal|revision|episode-complete> --timeout-ms <0..30000> --json
devexec mission result --mission <exact-id> --json
devexec mission events --mission <exact-id> [--after N] [--limit 1..1024] <--json|--jsonl>
devexec mission episodes --mission <exact-id> [--after N] [--limit 1..1024] --json
```

Mutating CLI commands require `DEV_EXEC_MISSION_AUTHORITY_FILE`. The local file is versioned as `devexec.mission-authority/v1` and binds exact source identities to allowed axes, roles, maximum authority, and exact Mission IDs or `*`. It contains no credential and grants no authority beyond the injected validator decision.

The CLI does not expose internal Episode dispatch because a CLI process cannot manufacture the parent freshness verification callback. Runtime adapters call the controller facade after validating their own source-owned receipt.

## Verification boundary

### Recovery and verification integrity

Every typed replay reopens all referenced Episode input, parent freshness,
Episode output, and follow-up artifacts and verifies their digest, kind and
exact Mission scope. Terminal reads also compare the complete MissionResult
semantics with its current APPLIED terminal command. Corruption fails closed
even after a prior successful completion; an old receipt cannot bypass replay.

Starting a new Episode or applying a follow-up reopens the Goal and removes
its previous completion binding. Goal and Mission completion require a PASS
Technical Verifier that is the latest Episode, following the latest applied
scope change. Its input already binds the exact pre-Episode revision and
projection hash. A later failed worker therefore requires fresh verification.

`controller.reconcile(missionId)` and `mission reconcile` recover only commands
already admitted to the existing source-owned journal. Recovery holds the same
public Mission transition lock across validation, apply, and result publication;
exact duplicate controls perform this recovery before returning their current
canonical receipt. Each recovered action rechecks current authority, typed
payloads, artifact integrity, revision/safe-boundary conditions and, for an
Episode start, the runtime parent's freshness callback. No worker side effects
are dispatched by reconciliation. The CLI cannot recover an Episode start that
requires a runtime freshness callback; the owning runtime must reconcile it.

An active Episode keeps boundary controls deferred. A recovered Episode outcome
can release that boundary. An APPLIED CANCEL/COMPLETE with no MissionResult is
reported by `result` as `RECONCILIATION_REQUIRED` until reconciliation publishes
the exact result once. Interrupted process lock ownership remains governed by
the existing source lock protocol; this API never deletes or breaks a lock.
Read-only inspection does not mutate recovery state. The multi-record protocol
is serialized and recoverable, not an assertion of one-write crash atomicity.

Event cursors use the latest canonical `journal_seq`, sorted before pagination.
Consumers receive a DEFERRED-to-APPLIED change after their previous cursor and
upsert by Event ID. Pages expose latest Event state, rather than every historic
journal record. Existing stored projections that conflict with the tightened
replay contract fail closed; there is no silent state migration or second journal.

The deterministic tests cover 10 fresh Episodes, independent Goal verification, one canonical result, duplicate replay, deferred pause across restart, consultation authority, role separation, stale revision, cross-Mission artifact rejection, corrupt payload rejection, cross-process lifecycle contention, strict CLI JSON/JSONL, bounded wait, and no-mutation invalid invocation.

No model/provider call or actual repository mutation is part of F03. F04/F05 must supply a qualified runtime and real Console/CLI fixture evidence before this becomes a complete end-to-end product flow.
