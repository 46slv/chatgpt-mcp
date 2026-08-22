# Dev Exec Mission runtime adversarial review — 2026-08-23

Status: **review corrections and concurrency hardening implemented on isolated branch; child-entry reservation + real checkout/Windows acceptance remain**

Base reviewed: `automation/devexec-mission-runtime-wiring-20260823@87d346a4de37ab1aeb9ecc4b0469184133f2937b`.

Review branch: `automation/devexec-mission-runtime-review-20260823`.

## Repaired findings

### 1. Amendment idempotency incorrectly depended on current child RUN

The original semantic identity included `created_for_run_id`, derived from `queue.current_run_id` when a redelivery omitted an explicit run ID. After `carryAmendmentsToRun()` moved the queue to a child RUN, the same operator delivery could fail `IDEMPOTENCY_KEY_CONFLICT` solely because the current RUN changed.

Correction: `created_for_run_id` remains immutable first-acceptance audit metadata but is not part of semantic request equality. Same-key/same-content redelivery remains idempotent across restart/child RUN; changed kind/mode/priority/payload still conflicts.

### 2. Public manual disposition bypassed the two-phase amendment fence

`setAmendmentDisposition(..., "APPLIED")` allowed `PENDING -> APPLIED` without `APPLYING`, `apply_attempt_id`, or mutation evidence.

Correction: manual disposition is limited to `REJECTED` / `CANCELLED`; direct `APPLIED` fails `APPLIED_REQUIRES_TWO_PHASE_APPLY`.

### 3. Same durable LAUNCHING attempt could spawn twice after restart

`beginMissionChildLaunch()` returned `{deduplicated:true}` for a matching already-`LAUNCHING` attempt, but the dispatcher ignored that and called `spawn()` again. A crash after OS spawn but before receipt persistence could therefore duplicate a child RUN.

Correction: `dispatchMissionChildLaunch()` fails `MISSION_LAUNCH_DISPATCH_ALREADY_IN_FLIGHT` before spawn when begin reports an existing in-flight attempt.

Targeted semantic reproduction: original retry path spawned once from a pre-existing `LAUNCHING` state; corrected path spawned zero times and failed closed.

### 4. Mission JSON writes could lose concurrent updates and erase an APPLYING fence

Atomic temp-write + rename protects against torn JSON but did not serialize read-modify-write cycles. Two controls opened at revision N could both write N+1; an ingress write from a stale `PENDING` snapshot could overwrite another process's durable `APPLYING` transition.

Correction:

- added `tools/devexec-mission-lock.mjs`, using atomic `openSync(..., "wx")` for a per-Mission inter-process write lock;
- lock metadata is fsynced and tokenized;
- normal release verifies token ownership before unlink;
- stale/crash residue is not automatically taken over by age/lease and therefore remains fail-closed until explicit reconciliation;
- async callbacks are rejected so mutation work cannot silently outlive the synchronous lock lifetime;
- Mission root/child attachment, amendment enqueue/select/begin/complete, launch request/begin/complete/ambiguous/reconcile/read now serialize through the same Mission lock and refresh durable state while held;
- stale bound controls fail rather than mutating a newer current RUN.

Deterministic pre-fix race reproduction restored amendment A from `APPLYING` back to stale `PENDING` when a second control enqueued B. The corrected semantic reconstruction preserves `A=APPLYING` and both A/B records.

### 5. Launch receipt persistence could race child attachment

Once the child attaches, the parent control becomes stale. A strict parent-bound check during receipt completion would therefore reject a legitimate receipt if the child won the race between Node `spawn` and parent receipt persistence.

Correction: launch **request/begin** remain bound to the current parent, while **complete/mark-ambiguous/read** may update the matching already-created launch after current-run advancement. Reconciliation uses durable child lineage, so a delayed reconcile can confirm a child even if the Mission has already advanced to a later descendant. New launch requests also reject a `child_run_id` already present in Mission lineage.

## Regression artifacts and validation

Checked-in review tests:

- `tools/devexec-mission-runtime-review.test.mjs`
  - cross-child amendment redelivery idempotency;
  - direct APPLIED fence bypass rejection;
  - stale amendment ingress preserving an APPLYING fence;
  - persisted LAUNCHING restart not respawning;
  - two stale launch controls not creating two active intents;
  - receipt completion after child attachment + delayed lineage reconciliation.
- `tools/devexec-mission-lock.test.mjs`
  - second writer exclusion;
  - release/reacquire;
  - callback-error release and stale-lock no-takeover;
  - async callback rejection.

Actual cloud-side reconstructed semantic executions performed during review:

- corrected Mission runtime scenarios: **6/6 PASS**;
- Mission lock primitive scenarios: **4/4 PASS**;
- original duplicate-dispatch reproduction: one unwanted spawn; corrected reproduction: zero spawns;
- original stale-control JSON race reproduction: `A` reverted from `APPLYING` to `PENDING` before locking was added.

These are targeted semantic reconstructions, not a repository checkout. Repository-wide Node tests, GitHub CI, real Local Agent/Bridge, and Windows host behavior are not claimed.

## Remaining integration risk: Local Agent starts before child-lineage acceptance

`devexec-goal.mjs` invokes `local-agent-facade.mjs start` before `openMissionControl()` validates/attaches child lineage. The facade persists a Local Agent run and invokes its worker during `start`. A stale or invalid child can therefore begin local work and only afterward fail Mission lineage validation.

Do not solve this by simply attaching the child before Local Agent start: parent launch reconciliation currently treats attached lineage as launch evidence, so an early attach could falsely confirm a child whose Local Agent start immediately fails.

Recommended next design: durable child-entry reservation/lifecycle, for example `RESERVED -> ACTIVE | AMBIGUOUS/FAILED`. Reserve and validate parent/child lineage under the Mission lock before Local Agent side effects; only transition to `ACTIVE` after a valid Local Agent start result is durably available. Launch `CONFIRMED` must require active child evidence, not a reservation alone. A crash between reservation and activation must remain fail-closed and inspectable.

## Exact next action

1. Run the existing Mission runtime tests plus both review test files from a real checkout; fix any integration mismatch.
2. Add the child-entry reservation/activation fence and wire `devexec-goal.mjs` through it.
3. Only then wire amendment consumption into production `dev-exec-loop.mjs` at persisted safe boundaries.
4. Run SHIRO-WS kill-after-spawn-before-receipt and concurrent amendment/launch probes; preserve stale lock / ambiguous state for explicit reconciliation rather than automatic retry.
5. Do not merge until these checks are read back.
