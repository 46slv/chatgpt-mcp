# Dev Exec Mission durable launch preflight review — 2026-08-23

Status: **review/repair branch; cloud static + focused semantic validation only**

Base reviewed: `automation/devexec-mission-target-normalization-20260823@5fa9b407edb069b766fec1569cbf4f2172d73d30`.

## Finding

Worker A correctly added target normalization and a regression that mutates the persisted `launch-state.json` after the caller has already received a launch object. The production dispatcher, however, validated `launch.target_alias` from that caller object before `beginMissionChildLaunch()`. The caller object can be stale: `beginMissionChildLaunch()` re-reads the durable record and persists `PENDING -> LAUNCHING`, then `buildMissionChildLaunchSpec()` validates the reloaded target/constraints/goal.

Therefore a durable record corrupted after the caller read could pass the stale preflight, transition to `LAUNCHING`, then fail deterministic spec validation without ever calling `spawn()`. The existing malformed-target test expects the record to remain `PENDING`, so the source as reviewed does not satisfy its own intended regression when the real suite is executed.

The same ordering issue applies to deterministic launch-spec failures such as corrupt durable constraints or an invalid entry path: these should not manufacture an in-flight launch attempt before any side effect is possible.

## Repair

`tools/devexec-mission-launcher.mjs` now re-reads `readMissionLaunchState(control)`, finds the durable launch by `launch_id`, and runs `buildMissionChildLaunchSpec()` against that durable record **before** `beginMissionChildLaunch()`.

This moves durable target/constraint/goal/status and command/entry validation ahead of `PENDING -> LAUNCHING`. The spec is built again from `begun.launch` after the transition so the actual dispatched data remains the authoritative post-begin record.

`tools/devexec-mission-target-validation.test.mjs` now additionally covers:

- durable `constraints` corruption rejected while the launch remains `PENDING`;
- invalid `entry_path` rejected while the launch remains `PENDING`;
- no spawn call and no launch attempt/request IDs for those deterministic failures.

The pre-existing stale-caller / malformed-durable-target tests now exercise the intended production ordering directly.

## Validation actually performed

- GitHub branch/file readback of the repaired launcher and updated regression file.
- Focused source-faithful semantic probe reproduced the reviewed ordering defect: stale caller validation allowed the durable record to become `LAUNCHING` before target/constraints/entry validation failed.
- The repaired ordering kept the same malformed cases `PENDING` and printed `MISSION_DURABLE_PREFLIGHT_SEMANTIC_PROBE=PASS`.

No repository checkout suite, GitHub CI, Windows, SHIRO-WS, real child process, or real Mission restart PASS is claimed in this cloud run.

## Exact next validation

From a real checkout run `tools/verify-devexec-mission-constraint-continuation.ps1`. It already includes `devexec-mission-target-validation.test.mjs`, so the stale-durable-target and new deterministic-preflight regressions should run with the rest of the Mission continuation bundle.

Then on SHIRO-WS continue the existing target/constraint/crash matrix. In particular, verify a deterministic malformed launch record never creates a persisted `LAUNCHING` attempt and never spawns a process. Keep `GOAL_PATCH / supersede_current_goal` out of scope until the continuation reliability acceptance closes.
