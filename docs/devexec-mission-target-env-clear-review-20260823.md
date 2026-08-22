# Dev Exec Mission target environment isolation review — 2026-08-23

Status: Worker B review / dedicated non-merge branch

Base reviewed: `automation/devexec-mission-constraint-continuation-20260823@be2bf10e76c87e6e549ac71fb73c159b623a8dfa`

## Finding

Worker A correctly fixed constraint-envelope leakage by making every child launch spec write `DEV_EXEC_MISSION_CONSTRAINTS_JSON`, including `[]` for an unconstrained child. The same launcher still merged `spawn_env` with `spec.env`, while `buildMissionChildLaunchSpec()` omitted `DEV_EXEC_TARGET_ALIAS` when the durable launch had `target_alias: null`.

That leaves a parallel environment-inheritance defect: an intentionally untargeted child can silently inherit `DEV_EXEC_TARGET_ALIAS` from a targeted parent process. `devexec-goal.mjs` rehydrates its target from that environment variable, so the child can route to the wrong target even though its durable launch state says `target_alias: null`.

## Repair

The durable fix is now at the launch-spec boundary, parallel to the existing constraint-envelope rule. `buildMissionChildLaunchSpec()` always writes `DEV_EXEC_TARGET_ALIAS`; a targeted launch writes the exact alias and an untargeted launch writes the explicit empty string `""`. `devexec-goal.mjs` already interprets an empty/blank inherited value as no explicit target.

`tools/devexec-mission-launcher.mjs` additionally keeps a defensive fallback: if a future launch spec were ever to omit the target key, the merged child environment removes an inherited parent alias before spawn.

This preserves the durable semantic distinction:

- `target_alias: "name"` => child receives exactly that alias;
- `target_alias: null` => child receives an explicit empty target override and uses normal/default routing instead of inheriting a stale parent alias.

## Regression coverage

Added `tools/devexec-mission-target-env-clear.test.mjs` with two dispatch-level cases using the real Mission launch APIs plus a fake spawned child:

1. untargeted child + targeted parent environment => launch spec and spawned child environment both contain `DEV_EXEC_TARGET_ALIAS=""`; the explicit empty constraint envelope also clears parent constraints; unrelated environment keys remain;
2. explicitly targeted child + differently targeted parent environment => launch spec and spawned child both receive the explicit child alias.

Updated `tools/verify-devexec-mission-constraint-continuation.ps1` to syntax-check the launcher and include the new regression in the focused Mission bundle.

## Validation actually run in cloud

- GitHub branch/file readback confirms the launch-spec repair, launcher defense, regression file, verifier extension, and this review document are persisted on the dedicated review branch.
- Focused Node semantic probe of the exact environment-merge rule: `TARGET_ENV_ISOLATION_SEMANTIC_PROBE=PASS`.
- Reconstructed syntax/behavior probe: `TARGET_ENV_RECONSTRUCTION=PASS`.
- A real repository checkout test, GitHub CI, Windows, and SHIRO-WS were **not** run in this cloud worker and are not claimed.

## Remaining acceptance

On a real checkout run `tools/verify-devexec-mission-constraint-continuation.ps1`. On SHIRO-WS include both environment-isolation cases in the existing continuation acceptance matrix: targeted parent -> untargeted child must observe no effective alias, and targeted parent -> explicitly targeted child must use the child alias. Preserve the existing constraint, target-continuity, and kill/restart checks.

Do not broaden to live `GOAL_PATCH` / `supersede_current_goal` until Mission continuation reliability and host acceptance are closed.
