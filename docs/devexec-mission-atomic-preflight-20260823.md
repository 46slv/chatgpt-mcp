# Dev Exec Mission atomic launch preflight — 2026-08-23

Status: **implementation branch; cloud connector readback + focused semantic validation only**

Base: `automation/devexec-mission-durable-preflight-review-20260823@9b9481ad22502615eb30e75556aeb89b66d7d23f`.

## Finding

The prior repair moved deterministic launch-spec validation before `beginMissionChildLaunch()`, but the preflight read and the `PENDING -> LAUNCHING` transition still occurred under two separate Mission-lock acquisitions. A cooperative or external writer could therefore change the durable launch between validation and begin. The dispatcher would then persist `LAUNCHING` from the newer record and discover malformed target/constraints/entry data only afterward, recreating the same false in-flight state through a narrower TOCTOU window.

## Repair

`beginMissionChildLaunch()` now accepts an optional synchronous `preflight` callback. For a `PENDING` launch it executes that callback against a clone of the exact durable launch record while the Mission lock is held and before any launch-attempt metadata is written. If validation throws, status, attempt/request IDs, lease token, and lease expiry remain untouched. Promise/async preflights are rejected before transition so the Mission lock is never escaped.

`dispatchMissionChildLaunch()` now performs `buildMissionChildLaunchSpec()` through that atomic begin preflight and dispatches from the returned validated spec. The separate durable pre-read was removed.

## Regression

`tools/devexec-mission-target-validation.test.mjs` now additionally proves:

- a corrupt durable launch rejected by begin preflight remains `PENDING` with no attempt/request/lease metadata;
- asynchronous preflight is rejected before `PENDING -> LAUNCHING`;
- the existing malformed target/constraints/entry dispatch regressions still exercise the production dispatcher, and the existing valid synthetic-spawn failure still reaches `AMBIGUOUS`.

The existing `tools/verify-devexec-mission-constraint-continuation.ps1` already syntax-checks both changed runtime modules and runs `devexec-mission-target-validation.test.mjs`, so no verifier-list change was required.

## Validation actually performed

- GitHub branch/file/commit readback of the implementation and regressions.
- Compare against the exact Worker B base confirmed this branch is additive only.
- Focused source-faithful old-vs-new semantic probe reproduced the old false-`LAUNCHING` TOCTOU outcome and verified the atomic ordering keeps malformed durable state `PENDING`: `MISSION_ATOMIC_PREFLIGHT_SEMANTIC_PROBE=PASS`.
- Direct cloud `git clone` was attempted and failed because this runtime cannot resolve `github.com`; therefore the repository checkout verifier, GitHub CI, Windows, SHIRO-WS, real child process, and real crash/restart matrix are **not** claimed as PASS.

## Exact next validation

On a real checkout run `tools/verify-devexec-mission-constraint-continuation.ps1` at this branch head. On SHIRO-WS add a concurrent/stale-writer case around launch preflight and prove malformed durable launch state cannot create `LAUNCHING`, attempt metadata, or a child process. Continue the existing target/constraint/crash matrix. Keep live `GOAL_PATCH / supersede_current_goal` PENDING until continuation reliability acceptance closes.
