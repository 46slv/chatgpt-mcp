# Dev Exec Mission target environment isolation review — 2026-08-23

Status: Worker B review / dedicated non-merge branch

Base reviewed: `automation/devexec-mission-constraint-continuation-20260823@be2bf10e76c87e6e549ac71fb73c159b623a8dfa`

## Finding

Worker A correctly fixed constraint-envelope leakage by making every child launch spec write `DEV_EXEC_MISSION_CONSTRAINTS_JSON`, including `[]` for an unconstrained child. The same launcher still merged `spawn_env` with `spec.env`, while `buildMissionChildLaunchSpec()` omitted `DEV_EXEC_TARGET_ALIAS` when the durable launch had `target_alias: null`.

That leaves a parallel environment-inheritance defect: an intentionally untargeted child can silently inherit `DEV_EXEC_TARGET_ALIAS` from a targeted parent process. `devexec-goal.mjs` rehydrates its target from that environment variable, so the child can route to the wrong target even though its durable launch state says `target_alias: null`.

## Repair

`tools/devexec-mission-launcher.mjs` now builds the merged child environment first and removes inherited `DEV_EXEC_TARGET_ALIAS` when the launch spec does not intentionally contain that key. Explicit child aliases continue to override the parent environment.

This keeps the existing durable semantic distinction:

- `target_alias: "name"` => child receives exactly that alias;
- `target_alias: null` => child uses normal/default routing and does not inherit a stale parent alias.

## Regression coverage

Added `tools/devexec-mission-target-env-clear.test.mjs` with two dispatch-level cases using the real Mission launch APIs plus a fake spawned child:

1. untargeted child + targeted parent environment => `DEV_EXEC_TARGET_ALIAS` is absent from the child environment, the explicit empty constraint envelope still clears parent constraints, unrelated environment keys remain;
2. explicitly targeted child + differently targeted parent environment => child receives the explicit child alias.

Updated `tools/verify-devexec-mission-constraint-continuation.ps1` to syntax-check the launcher and include the new regression in the focused Mission bundle.

## Validation actually run in cloud

- GitHub branch/file readback confirms the launcher repair and regression file are persisted on the dedicated review branch.
- Focused Node semantic probe of the exact environment-merge rule: `TARGET_ENV_ISOLATION_SEMANTIC_PROBE=PASS`.
- A real repository checkout test, GitHub CI, Windows, and SHIRO-WS were **not** run in this cloud worker and are not claimed.

## Remaining acceptance

On a real checkout run `tools/verify-devexec-mission-constraint-continuation.ps1`. On SHIRO-WS include both environment-isolation cases in the existing continuation acceptance matrix: targeted parent -> untargeted child must clear the alias, and targeted parent -> explicitly targeted child must use the child alias. Preserve the existing constraint, target-continuity, and kill/restart checks.

Do not broaden to live `GOAL_PATCH` / `supersede_current_goal` until Mission continuation reliability and host acceptance are closed.
