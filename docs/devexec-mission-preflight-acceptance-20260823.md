# Dev Exec Mission preflight / crash-replay acceptance — 2026-08-23

Status: **implementation + checkout acceptance packet; host integration still pending**

Branch: `automation/devexec-mission-preflight-acceptance-20260823`
Base reviewed: `automation/devexec-mission-atomic-preflight-review-20260823@5e56212b5bb5c2c4245fda11811a945aaef3c8a2`

## Why this continuation exists

The atomic-preflight review correctly moved deterministic durable launch validation into the same Mission lock/snapshot as `PENDING -> LAUNCHING`, prohibited callback execution there, and moved caller accessor/Proxy evaluation outside the lock. The remaining verification packet was too narrow: the existing PowerShell verifier did not execute several Mission lock/replay/admission regressions and did not run the existing real Node child spawn/reconciliation probe.

This branch makes the existing checkout command represent the current reliability surface more accurately and adds a real cross-process crash/restart regression.

## Changes

`tools/verify-devexec-mission-constraint-continuation.ps1` now:

- syntax-checks the Mission amendment, lock, control, launch, launcher, admission, entry, constraint, target, Goal and Local Agent state modules;
- runs the focused Mission objective/amendment/boundary/constraint/lock/control/launch/admission/entry/root/target/Local Agent/continuation test bundle;
- runs `tools/devexec-mission-launch-real-e2e.mjs`, which spawns a real temporary Node child and verifies durable receipt plus child-lineage reconciliation;
- runs the new cross-process crash regression as part of the Node test bundle.

`tools/devexec-mission-process-crash.test.mjs` adds two process-boundary cases:

1. A helper process durably enters `LAUNCHING` and exits before spawn/receipt. A fresh process reopens the Mission and proves the same durable attempt cannot spawn again.
2. A helper process durably enters `LAUNCHING`, performs a child-side effect using a separate Node process, then exits without a launch receipt. A fresh process proves restart does not execute the child side effect a second time.

These tests use only temporary directories and the current Node executable. They do not call Local Executor, Resolve, the network, or external publication surfaces.

## Evidence actually obtained in the cloud worker

- GitHub branch/file/commit readback: PASS.
- New crash-regression source readback: PASS.
- Reconstructed authored crash-regression JavaScript `node --check`: PASS on Node `v22.16.0`.
- Direct repository checkout/test execution: **NOT RUN** because the cloud container cannot resolve `github.com` for `git clone`/`git ls-remote`.
- GitHub combined status on the branch checkpoint: no statuses registered.

Do not convert the source/readback evidence above into a repository-suite PASS.

## Exact checkout verification

From an actual checkout of this branch:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\verify-devexec-mission-constraint-continuation.ps1
```

Expected terminal marker:

```text
MISSION_RELIABILITY_CHECK=PASS
```

The command now includes a real Node child spawn/receipt/reconciliation probe and actual cross-process exit/restart regressions, but it still does **not** prove forced OS-kill timing, power-loss durability, Local Agent/Local Executor integration, or SHIRO-WS-specific behavior.

## Remaining host acceptance

On SHIRO-WS, after the checkout verifier passes:

- malformed durable target/constraints/Goal/parent/child/entry must remain `PENDING` with no attempt/request metadata and no child spawn;
- callback/accessor preflight input must execute no caller code while the Mission lock is held;
- a concurrent/stale writer must fail closed rather than overwrite the current Mission state;
- targeted parent -> untargeted child must clear ambient target alias; explicit child target must override correctly; constraints must not leak into unrelated descendants;
- forced termination around durable `LAUNCHING`, child spawn before receipt, `LAUNCHED` before child attach, and child attach before delayed receipt must never produce duplicate Local Agent/child execution;
- power-loss/fsync durability remains a separate claim and is not implied by process-exit tests.

`GOAL_PATCH` / `supersede_current_goal` should remain PENDING until this reliability acceptance is closed. The next product slice after that is the local typed Control API/service, followed by the minimal Operator Console, per current Notion requirements.
