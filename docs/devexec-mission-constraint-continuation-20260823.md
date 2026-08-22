# Dev Exec Mission constraint continuation — 2026-08-23

Status: cloud implementation checkpoint; **not** Windows/SHIRO-WS acceptance.

Base: `automation/devexec-mission-target-continuation-review-20260823@08a6ad2b3881159f56fb5db42267b2729ce60d39`

## Problem closed by this branch

The previous review correctly stopped marking `constraint` / `constraints` as APPLIED because the runtime persisted them but no execution surface consumed them. This branch adds a deliberately narrow consumption path without inventing replay-safe live-Goal mutation.

Supported now:

- `MISSION_AMENDMENT`
- `apply_mode: after_current_goal`
- `add_work` plus optional `constraint` / `constraints`

The constraints are an atomic part of that amendment's queued work item. They are snapshotted into the child launch journal, included in launch idempotency comparison, transported as `DEV_EXEC_MISSION_CONSTRAINTS_JSON`, rendered into the Local Agent continuation Goal, and also rendered into the Supervisor repair target if the constrained child escalates.

Still unsupported/PENDING:

- `next_safe_boundary` constraint mutation of an already-running Goal;
- constraint-only `after_current_goal` amendments with no scoped work item;
- `GOAL_PATCH`;
- `supersede_current_goal`.

This prevents a late or standalone constraint from being falsely marked APPLIED without a concrete execution target.

## Scope and durability

- `tools/devexec-mission-objective.mjs`: supports constraints only when atomically paired with `after_current_goal` work; each queued work entry stores its own constraint snapshot. The existing top-level constraint list remains audit evidence, but launch selection uses the work-local snapshot so unrelated later work does not inherit earlier constraints.
- `tools/devexec-mission-loop-boundary.mjs`: carries only the selected work item's constraints into the continuation request.
- `tools/devexec-mission-launch.mjs`: persists `constraints` in launch state, includes them in semantic idempotency comparison, and exports them to child environment.
- `tools/devexec-mission-constraint-envelope.mjs`: validates the typed string-array transport and deterministically renders the constraint envelope.
- `tools/devexec-goal.mjs`: consumes the envelope before Local Agent start; the Local Agent's durable mission string therefore includes the constraints. On Supervisor escalation, the same constraints are appended to `DEV_EXEC_TARGET`. The owner file records the original Goal plus `mission_constraints` separately.
- `tools/devexec-local-agent-goal-state.mjs`: validates the optional durable owner constraint envelope; legacy owners without it remain valid.

The prompt-level constraint envelope is an explicit consumption surface, not a claim of hard action-level policy enforcement. Existing typed executor/profile boundaries remain the hard execution boundary.

## Regression coverage added/updated

- `tools/devexec-mission-constraint-continuation.test.mjs`
  - scoped constraints persist into queued work, launch state, target alias, and child env;
  - an unrelated later work item does not inherit the first amendment's constraints;
  - live `next_safe_boundary` constraints remain PENDING;
  - standalone `after_current_goal` constraints remain PENDING;
  - malformed transport fails closed.
- `tools/devexec-mission-objective.test.mjs`
  - ordinary work stores an empty constraint snapshot;
  - constrained after-current work persists the scoped snapshot and receipt count;
  - unsupported live/standalone constraint cases match the new fail-closed contract.
- `tools/devexec-local-agent-mission-boundary.test.mjs`
  - supervised continuation carries constraint env;
  - legacy owner remains valid;
  - malformed persisted owner constraints fail before continuation mutation.
- `tools/verify-devexec-mission-constraint-continuation.ps1`
  - fail-closed real-checkout verifier for the changed module syntax and six focused Mission test files;
  - intentionally does not claim process-kill/restart host acceptance.

## Validation actually performed in this cloud run

A real checkout was attempted first and failed because this container cannot resolve `github.com`. Therefore repository tests and GitHub CI are **not** claimed as passing.

Two source-faithful isolated Node semantic harnesses were executed against the implemented contracts:

1. Constraint objective / scoped work / launch transport / idempotency / envelope semantics: **8/8 PASS**.
2. Local Goal + Supervisor target envelope / legacy owner / malformed-owner fail-closed semantics: **4/4 PASS**.

GitHub connector readback confirms the dedicated branch contains the implementation, regression files, and real-checkout verifier. No combined CI statuses are registered at this checkpoint.

## Required real-checkout / SHIRO-WS acceptance

1. Run `tools/verify-devexec-mission-constraint-continuation.ps1` from the exact branch checkout. It checks the changed module syntax and focused objective/amendment/boundary/constraint/owner/dispatcher tests.
2. Start an explicit-target root Mission, enqueue `after_current_goal` work with constraints, and prove the exact constraints appear in:
   - mission objective queued work;
   - launch state;
   - child environment;
   - Local Agent durable Goal;
   - Supervisor target if the child escalates.
3. Complete the child and launch an unrelated second work item with no constraints; prove the first work's scoped constraints do not leak into it.
4. Kill/restart at the existing reliability points: objective write, PENDING launch, LAUNCHING/spawn-before-receipt, LAUNCHED-before-child-attach. No duplicate child, lost constraint envelope, or target drift.
5. Submit `next_safe_boundary` and standalone `after_current_goal` constraint amendments and prove they remain PENDING with no execution side effect.

Do not enable live Goal replacement or broaden constraints beyond this scoped continuation contract until a replay-safe typed mutation/enforcement surface exists.
