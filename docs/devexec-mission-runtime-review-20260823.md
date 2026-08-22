# Dev Exec Mission runtime adversarial review — 2026-08-23

Status: **review corrections implemented on isolated branch; production wiring still blocked on remaining concurrency/host checks**

Base reviewed: `automation/devexec-mission-runtime-wiring-20260823@87d346a4de37ab1aeb9ecc4b0469184133f2937b`.

Review branch: `automation/devexec-mission-runtime-review-20260823`.

## Repaired findings

### 1. Amendment idempotency incorrectly depended on current child RUN

The original semantic identity included `created_for_run_id`, derived from `queue.current_run_id` when a redelivery omitted an explicit run ID. After `carryAmendmentsToRun()` moved the queue from `RUN-001` to `RUN-002`, redelivering the same operator request with the same idempotency key compared `RUN-002` against the original audit origin `RUN-001` and failed `IDEMPOTENCY_KEY_CONFLICT`.

Correction: `created_for_run_id` remains immutable audit metadata on first acceptance but is not part of semantic request equality. Same-key/same-content delivery remains idempotent across restart/child RUN; a genuinely changed kind/mode/priority/payload still conflicts.

### 2. Public manual disposition could bypass the two-phase apply fence

`setAmendmentDisposition(..., "APPLIED")` previously allowed `PENDING -> APPLIED` without `APPLYING`, `apply_attempt_id`, or mutation evidence. That contradicted the crash-fence invariant implemented by `beginAmendmentApply()` / `completeAmendmentApply()`.

Correction: manual disposition is limited to `REJECTED` / `CANCELLED`; direct `APPLIED` fails `APPLIED_REQUIRES_TWO_PHASE_APPLY`.

### 3. Retrying the same durable LAUNCHING attempt could spawn a duplicate child

`beginMissionChildLaunch()` deliberately returns `{deduplicated:true}` for a matching already-`LAUNCHING` attempt. The dispatcher ignored that result and proceeded to `spawn()` again. A crash after OS spawn but before receipt persistence therefore left a durable `LAUNCHING` record that could spawn a second child on retry, despite the documented fail-closed requirement.

Correction: `dispatchMissionChildLaunch()` treats a deduplicated `LAUNCHING` begin as ambiguous/in-flight and fails `MISSION_LAUNCH_DISPATCH_ALREADY_IN_FLIGHT` before `spawn()`.

Targeted semantic reproduction before correction: original retry path invoked spawn once from an already-`LAUNCHING` state; corrected path invoked spawn zero times and failed closed.

## Regression artifact

`tools/devexec-mission-runtime-review.test.mjs` adds three focused guards:

1. same amendment delivery deduplicates after child-run carry and retains original audit origin;
2. direct manual `APPLIED` cannot bypass the two-phase fence;
3. restarted dispatcher does not respawn an already durable matching `LAUNCHING` attempt.

No repository-wide test run or Windows host acceptance is claimed by this review.

## Remaining merge blocker: mission-file mutation is not serialized

The current Mission Control objects keep mutable in-memory copies and persist them with temp-write + rename, but there is no per-Mission lock or atomic compare-and-swap across processes. Two independently opened controls can therefore overwrite each other.

Deterministic failure shape:

1. Control A and Control B both open revision N of `amendments.json`.
2. A begins an amendment apply and persists `APPLYING` at revision N+1.
3. B, still holding revision N with that amendment as `PENDING`, enqueues another amendment and saves its stale object at revision N+1.
4. The second write can restore the first amendment to `PENDING`, erasing the crash fence and making replay possible.

The same class exists for simultaneous launch-state mutations. Temp-file rename prevents torn JSON, not lost updates.

Required before production safe-boundary ingestion/self-launch: serialize all Mission state/amendment/launch mutations under one per-Mission inter-process lock, or implement an actually atomic revision/CAS primitive. A conservative lock may remain fail-closed after process death and require explicit reconciliation; it must not use lease expiry alone as permission to overwrite ambiguous in-flight state.

## Additional integration risk: Local Agent starts before child-lineage acceptance

`devexec-goal.mjs` invokes `local-agent-facade.mjs start` before `openMissionControl()` validates/attaches child lineage. The facade persists a Local Agent run and invokes its worker during `start`. A stale/invalid child can therefore start local work and only afterward fail Mission lineage validation.

Do not simply attach lineage earlier without changing confirmation semantics: parent launch reconciliation currently treats attached current child lineage as `CONFIRMED`, so attaching before a successful Local Agent start could falsely confirm a child that immediately failed. The safe next design is a preflight/reservation state or a child lifecycle (`RESERVED -> ACTIVE/FAILED`) whose `ACTIVE` transition occurs only after Local Agent start succeeds; launch confirmation should require that active evidence.

## Next action

Before wiring amendment consumption into `dev-exec-loop.mjs`, incorporate the three review corrections, add per-Mission mutation serialization, and define child entry reservation/activation semantics. Then run the existing Mission runtime suite plus the new review regressions and a deterministic two-control lost-update test. Only afterward perform the SHIRO-WS kill-after-spawn-before-receipt probe and production loop integration.
