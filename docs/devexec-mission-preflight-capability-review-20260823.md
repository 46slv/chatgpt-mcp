# Dev Exec Mission launch preflight capability review — 2026-08-23

Status: **review/repair branch; connector readback + focused semantic validation only**

Base: `automation/devexec-mission-atomic-preflight-20260823@643bb10985020ea3d366cef6e1197817166d7dfe`.

## Finding

Worker A correctly closed the launch-state TOCTOU by moving deterministic launch-spec validation into the same Mission lock/snapshot as `PENDING -> LAUNCHING`. The remaining review concern was the shape of that API: `beginMissionChildLaunch()` accepted an arbitrary synchronous `preflight` callback and executed it while the Mission lock was held before the durable transition.

That callback surface was broader than the invariant it was intended to enforce. A future caller could perform unrelated filesystem/process/other side effects inside the callback and then throw, leaving the durable launch `PENDING` while an unjournaled side effect had already occurred. The current production dispatcher passed a pure spec builder, so this was a capability/safety regression risk rather than evidence that the present dispatcher had already performed such a side effect.

## Repair

- Added `createMissionChildDispatchPreflight(control, {entry_path, node_path})` in `devexec-mission-launch.mjs`.
- The module records factory-created callbacks in a private `WeakSet` and `beginMissionChildLaunch()` accepts only those one-shot capabilities.
- Arbitrary synchronous or async callbacks are rejected with `MISSION_LAUNCH_UNTRUSTED_PREFLIGHT` before invocation and before any `LAUNCHING`, attempt/request, or lease metadata is written.
- The trusted callback can only call the existing pure `buildMissionChildLaunchSpec()` against the durable launch clone.
- `dispatchMissionChildLaunch()` now creates that trusted capability rather than supplying its own callback.

This keeps A's atomic snapshot/transition property while narrowing the code that may execute inside the Mission lock.

## Regression

`tools/devexec-mission-target-validation.test.mjs` now covers:

1. trusted dispatch preflight still rejects malformed durable constraints before `PENDING -> LAUNCHING`;
2. arbitrary synchronous preflight is rejected without being invoked and without launch metadata mutation;
3. arbitrary async preflight is rejected without being invoked and without transition;
4. existing malformed target/constraints/entry and valid spawn-boundary regressions remain in the same suite.

The existing `tools/verify-devexec-mission-constraint-continuation.ps1` already syntax-checks the modified runtime modules and runs this test file, so the real-checkout acceptance entrypoint remains unchanged.

## Validation actually performed

- Re-fetched Worker A head immediately before branching: exact `643bb10985020ea3d366cef6e1197817166d7dfe`.
- Dedicated review branch created without rewriting A history.
- GitHub file/commit readback and compare performed after each write.
- Cloud `git clone` was retried and again failed at DNS resolution for `github.com`; therefore repository-checkout tests, GitHub CI, Windows/SHIRO-WS, real child process, and crash/restart acceptance are **not** claimed as PASS.
- Focused capability semantics were inspected against the committed diff: untrusted callbacks are gated before invocation; trusted dispatch preflight remains inside the same lock/snapshot as the transition.

## Remaining acceptance

On a real checkout run `tools/verify-devexec-mission-constraint-continuation.ps1` at this branch head. On SHIRO-WS continue the existing target/constraint/crash matrix and add a regression/harness case proving no caller-controlled preflight side effect can occur while a launch remains `PENDING`. Keep live `GOAL_PATCH / supersede_current_goal` PENDING until Mission continuation reliability acceptance closes.
