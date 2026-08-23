# Dev Exec Mission lock lifetime review — 2026-08-23

Status: **review repair / cloud-focused evidence; real checkout and SHIRO-WS acceptance still required**

Base reviewed: `automation/devexec-mission-recovery-arbitration-20260823@a994fae363834623f63d3623e61859a4f2615156`.

## Finding

The recovery-arbitration repair correctly consolidates stale-lock mutation, but `withMissionLock()` still had a separate lifetime escape. It invoked the callback first, detected a returned Promise only afterward, then released the Mission lock in synchronous `finally` while the Promise continuation remained runnable.

The existing regression used `async () => "late mutation"`; that callback has no `await` continuation and therefore did not prove the stated invariant that work cannot outlive the synchronous lock. A declared async callback could also execute its pre-`await` body once before the API rejected it.

Source-faithful reproduction against the prior semantics produced **0/2** on the new lifetime regressions:

1. declared async callback body started once before rejection;
2. a Promise-returning wrapper did not retain the lock for the returned continuation.

## Repair

`tools/devexec-mission-lock.mjs` now keeps the synchronous-only contract fail-closed:

- declared `AsyncFunction` / `AsyncGeneratorFunction` callbacks are rejected **before invocation**, so their body cannot begin;
- if an otherwise synchronous callback returns a thenable, the API still throws `MISSION_LOCK_ASYNC_CALLBACK_UNSUPPORTED`, but the canonical Mission lock remains held until that returned thenable settles;
- deferred release failure is surfaced as a process warning rather than silently claiming successful cleanup.

This does not make arbitrary asynchronous callbacks supported. Detached work that is not represented by the returned thenable remains outside the contract; production callers should remain synchronous.

## Adjacent release-state repair

The same review found a smaller availability defect in the lock handle itself: `release()` set its in-memory `released` flag **before** the canonical unlink. A transient filesystem error could therefore leave `mission-control.lock` intact while permanently making that handle return `false` on later release attempts.

The handle now marks itself released only after `fs.rmSync()` succeeds. Ownership is still re-read and token/PID-checked before every attempt, so a retry cannot remove a replacement owner's lock. A targeted semantic probe injected one `EBUSY`, confirmed the canonical lock remained, then confirmed the same owner could retry successfully.

## Regression coverage

Added `tools/devexec-mission-lock-lifetime.test.mjs`:

- declared async callback is rejected with callback count `0` and no lock publication;
- Promise-returning wrapper is rejected, lock stays present while pending, its returned continuation observes `MISSION_CONTROL_LOCKED`, and the lock disappears only after settlement;
- a simulated transient canonical-unlink failure leaves the owning handle retryable; the next verified release succeeds and post-success release remains idempotent.

The Mission reliability verifier includes this test.

## Validation actually run

Using the fetched branch source reconstructed in the cloud Node runtime:

- prior `withMissionLock()` semantics + initial lifetime test: **0/2**, expected defect reproduced;
- repaired `devexec-mission-lock.mjs` + initial lifetime test: **2/2 PASS**;
- repaired module + existing `devexec-mission-lock.test.mjs` + initial lifetime test: **6/6 PASS**;
- `node --check` passed for the repaired module and initial new test;
- targeted release-state semantic probe: injected `EBUSY` -> canonical preserved -> same owner retry succeeds: **PASS**;
- GitHub branch/file/commit write and readback succeeded.

The cloud container still cannot resolve `github.com`, so the full repository checkout verifier could not be executed here.

Not claimed: full repository checkout verifier, GitHub CI, Windows/SHIRO-WS filesystem behavior, Local Agent/Local Executor integration, forced OS kill, or power-loss durability.

## Next acceptance

Worker A should reconcile this focused diff, run `powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\verify-devexec-mission-constraint-continuation.ps1` on a real checkout, and keep the existing SHIRO-WS recovery/kill matrix. Add host regressions where:

1. a Promise-returning wrapper is rejected and a competing Mission writer cannot acquire until that returned thenable settles;
2. one transient canonical unlink failure leaves the still-owning lock handle able to release successfully on a verified retry.

Keep `GOAL_PATCH / supersede_current_goal` pending until Mission reliability acceptance closes.
