# Dev Exec Mission preflight / crash-replay acceptance — 2026-08-23

Status: **implementation + checkout acceptance packet; host integration still pending**

Branch: `automation/devexec-mission-preflight-acceptance-20260823`
Base reviewed: `automation/devexec-mission-atomic-preflight-review-20260823@5e56212b5bb5c2c4245fda11811a945aaef3c8a2`

## Why this continuation exists

The atomic-preflight review correctly moved deterministic durable launch validation into the same Mission lock/snapshot as `PENDING -> LAUNCHING`, prohibited callback execution there, and moved caller accessor/Proxy evaluation outside the lock. The remaining verification packet was too narrow: the existing PowerShell verifier did not execute several Mission lock/replay/admission regressions and did not run the existing real Node child spawn/reconciliation probe.

This branch makes the existing checkout command represent the current reliability surface more accurately and adds real cross-process crash/restart and lock-contention regressions.

## Changes

`tools/verify-devexec-mission-constraint-continuation.ps1` now:

- syntax-checks the Mission amendment, lock, control, launch, launcher, admission, entry, constraint, target, Goal and Local Agent state modules;
- runs the focused Mission objective/amendment/boundary/constraint/lock/control/launch/admission/entry/root/target/Local Agent/continuation test bundle;
- includes cross-process Mission lock and crash/restart tests;
- runs `tools/devexec-mission-launch-real-e2e.mjs`, which spawns a real temporary Node child and verifies durable receipt plus child-lineage reconciliation.

`tools/devexec-mission-process-crash.test.mjs` adds two process-boundary cases:

1. A helper process durably enters `LAUNCHING` and exits before spawn/receipt. A fresh process reopens the Mission and proves the same durable attempt cannot spawn again.
2. A helper process durably enters `LAUNCHING`, performs a child-side effect using a separate Node process, then exits without a launch receipt. A fresh process proves restart does not execute the child side effect a second time.

`tools/devexec-mission-lock-process.test.mjs` adds two real process-boundary lock cases:

1. A separate helper process holds the Mission lock while the test process proves a competing writer fails with `MISSION_CONTROL_LOCKED`; after explicit release, acquisition succeeds again.
2. A helper exits without releasing the lock; the durable stale lock remains and a restart writer fails closed rather than silently taking ownership.

These tests use only temporary directories and the current Node executable. They do not call Local Executor, Resolve, the network, or external publication surfaces.

## Evidence actually obtained in the cloud worker

- GitHub branch/file/commit readback: PASS.
- New crash/lock regression source readback: PASS.
- Reconstructed authored crash-regression JavaScript `node --check`: PASS on Node `v22.16.0`.
- Source-faithful reconstruction of the fetched production Mission lock plus the new cross-process lock regression: **2/2 PASS** on Node `v22.16.0`.
- Direct repository checkout/test execution: **NOT RUN** because the cloud container cannot resolve `github.com` for `git clone`/`git ls-remote`.
- GitHub combined status on the branch checkpoint: no statuses registered during this worker run.

Do not convert the reconstruction/readback evidence above into a repository-suite PASS.

## Exact checkout verification

From an actual checkout of this branch:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\verify-devexec-mission-constraint-continuation.ps1
```

Expected terminal marker:

```text
MISSION_RELIABILITY_CHECK=PASS
```

The command now includes real Node process lock contention, real process exit/restart replay regressions, and a real child spawn/receipt/reconciliation probe. It still does **not** prove forced OS-kill timing, power-loss durability, Local Agent/Local Executor integration, or SHIRO-WS-specific behavior.

## Remaining host acceptance

On SHIRO-WS, after the checkout verifier passes:

- malformed durable target/constraints/Goal/parent/child/entry must remain `PENDING` with no attempt/request metadata and no child spawn;
- callback/accessor preflight input must execute no caller code while the Mission lock is held;
- targeted parent -> untargeted child must clear ambient target alias; explicit child target must override correctly; constraints must not leak into unrelated descendants;
- forced termination around durable `LAUNCHING`, child spawn before receipt, `LAUNCHED` before child attach, and child attach before delayed receipt must never produce duplicate Local Agent/child execution;
- stale-lock recovery is intentionally fail-closed today; automatic stale-lock takeover is not accepted by these tests;
- power-loss/fsync durability remains a separate claim and is not implied by process-exit tests.

`GOAL_PATCH` / `supersede_current_goal` should remain PENDING until this reliability acceptance is closed. The next product slice after that is the local typed Control API/service, followed by the minimal Operator Console, per current Notion requirements.
