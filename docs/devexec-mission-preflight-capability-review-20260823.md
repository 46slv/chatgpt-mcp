# Dev Exec Mission launch preflight capability review — 2026-08-23

Status: **review/repair branch; connector readback + focused semantic validation only**

Base: `automation/devexec-mission-atomic-preflight-20260823@643bb10985020ea3d366cef6e1197817166d7dfe`.

## Finding 1 — generic atomic-preflight callback was too broad

Worker A correctly closed the launch-state TOCTOU by moving deterministic launch-spec validation into the same Mission lock/snapshot as `PENDING -> LAUNCHING`. The remaining review concern was the shape of that API: `beginMissionChildLaunch()` accepted an arbitrary synchronous `preflight` callback and executed it while the Mission lock was held before the durable transition.

That callback surface was broader than the invariant it was intended to enforce. A future caller could perform unrelated filesystem/process/other side effects inside the callback and then throw, leaving the durable launch `PENDING` while an unjournaled side effect had already occurred. The current production dispatcher passed a pure spec builder, so this was a capability/safety regression risk rather than evidence that the present dispatcher had already performed such a side effect.

## Repair 1 — one-shot trusted dispatch capability

- Added `createMissionChildDispatchPreflight(control, {entry_path, node_path})` in `devexec-mission-launch.mjs`.
- The module records factory-created callbacks in a private `WeakSet` and `beginMissionChildLaunch()` accepts only those one-shot capabilities.
- Arbitrary synchronous or async callbacks are rejected with `MISSION_LAUNCH_UNTRUSTED_PREFLIGHT` before invocation and before any `LAUNCHING`, attempt/request, or lease metadata is written.
- The trusted callback can only call the existing pure `buildMissionChildLaunchSpec()` against the durable launch clone.
- `dispatchMissionChildLaunch()` now creates that trusted capability rather than supplying its own callback.

This keeps A's atomic snapshot/transition property while narrowing the code that may execute inside the Mission lock.

## Finding 2 — durable launch identity fields were not fully revalidated

The atomic preflight was revalidating target alias, constraints, node path, entry path, mission equality, and status, but `buildMissionChildLaunchSpec()` still copied durable `goal`, `parent_run_id`, and `child_run_id` into argv/environment without applying the same required-string checks used at request time.

A corrupted or legacy `PENDING` launch could therefore keep a blank/non-string Goal or lineage ID long enough to cross `PENDING -> LAUNCHING` and reach the spawn boundary. That would manufacture an in-flight launch from invalid durable identity even though the original request contract would have rejected the value.

## Repair 2 — durable identity validation in the atomic spec builder

`buildMissionChildLaunchSpec()` now validates and canonicalizes the exact durable snapshot before transition:

- `launch.mission_id` must be a non-empty string and match the control Mission;
- `launch.parent_run_id` must be a non-empty string;
- `launch.child_run_id` must be a non-empty string;
- `launch.goal` must be a non-empty string;
- existing status/constraints/target/entry/node validation remains unchanged.

The validated values, rather than the raw durable fields, are used to build argv/environment.

## Regression

`tools/devexec-mission-target-validation.test.mjs` now covers:

1. trusted dispatch preflight still rejects malformed durable constraints before `PENDING -> LAUNCHING`;
2. arbitrary synchronous preflight is rejected without being invoked and without launch metadata mutation;
3. arbitrary async preflight is rejected without being invoked and without transition;
4. corrupt durable `goal`, `parent_run_id`, and `child_run_id` each remain `PENDING`, generate no attempt/request/lease metadata, and never reach `spawn()`;
5. existing malformed target/constraints/entry and valid spawn-boundary regressions remain in the same suite.

The existing `tools/verify-devexec-mission-constraint-continuation.ps1` already syntax-checks the modified runtime modules and runs this test file, so the real-checkout acceptance entrypoint remains unchanged.

## Validation actually performed

- Re-fetched Worker A head immediately before branching: exact `643bb10985020ea3d366cef6e1197817166d7dfe`.
- Dedicated review branch created without rewriting A history.
- GitHub file/commit readback and compare performed around writes.
- Cloud `git clone` was retried and again failed at DNS resolution for `github.com`; therefore repository-checkout tests, GitHub CI, Windows/SHIRO-WS, real child process, and crash/restart acceptance are **not** claimed as PASS.
- Focused review of the committed semantics confirms untrusted callbacks are gated before invocation and the trusted dispatch preflight performs launch-spec construction against the exact durable snapshot under the same Mission lock as the transition.
- Regression code for durable Goal/lineage corruption is committed, but it still requires execution by the real-checkout verifier.

## Remaining acceptance

On a real checkout run `tools/verify-devexec-mission-constraint-continuation.ps1` at this branch head. On SHIRO-WS continue the existing target/constraint/crash matrix and add malformed durable `goal` / `parent_run_id` / `child_run_id` cases, plus a regression/harness case proving no caller-controlled preflight side effect can occur while a launch remains `PENDING`. Keep live `GOAL_PATCH / supersede_current_goal` PENDING until Mission continuation reliability acceptance closes.
