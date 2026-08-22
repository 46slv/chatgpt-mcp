# Dev Exec Mission target normalization hardening — 2026-08-23

Status: cloud implementation checkpoint; real-checkout and SHIRO-WS acceptance remain required.

## Starting authority

This branch starts from Worker B `automation/devexec-mission-target-env-clear-review-20260823@73922cf714a31baa64fa2814ddbf0f4336b9f81f`. That checkpoint already makes child target isolation explicit at the launch-spec boundary: targeted continuations export the exact alias and untargeted continuations export an explicit empty `DEV_EXEC_TARGET_ALIAS` so a targeted parent cannot leak routing into unrelated child work.

## Additional failure mode

The launch request schema historically treated `target_alias` as an optional value but did not validate its durable value immediately before the irreversible spawn boundary. A malformed persisted value such as a blank string or non-string object could therefore survive in a PENDING launch. Node child-process environment construction may coerce non-string values, so dispatching such a record risks routing to unintended text such as `[object Object]` or failing only after the durable launch has moved to LAUNCHING.

The goal entrypoint also normalized inherited environment aliases with `.trim()`, but the explicit `--target` argument did not share that validation, and the descendant environment was built by copying the parent environment and only setting the target when truthy. That left target-selection semantics distributed across multiple call sites.

## Repair

- Added `tools/devexec-target-alias.mjs` as the shared normalization surface.
  - inherited transport: blank means no explicit target; non-string fails closed;
  - durable/explicit target: must be a non-blank string and is whitespace-canonicalized;
  - descendant environment: selected target is written canonically; no target removes inherited `DEV_EXEC_TARGET_ALIAS`.
- `tools/devexec-mission-launcher.mjs` validates the durable launch target before `beginMissionChildLaunch()`, so malformed PENDING state cannot be promoted to LAUNCHING and cannot reach `spawn()`.
- `tools/devexec-goal.mjs` now uses the same helper for inherited target parsing, `--target` validation, and Local Agent / Supervisor descendant environment construction.
- Worker B's launch-spec isolation remains unchanged: an untargeted Mission child still receives explicit `DEV_EXEC_TARGET_ALIAS=""` at process entry so parent routing is cancelled before `devexec-goal.mjs` converts blank transport to semantic null.

## Regression coverage

- `tools/devexec-mission-target-validation.test.mjs`
  - blank/non-string durable launch targets are rejected before PENDING -> LAUNCHING;
  - spawn is not reached and launch attempt metadata remains unset;
  - a valid target still crosses the normal launch side-effect boundary.
- `tools/devexec-target-alias.test.mjs`
  - blank inherited transport -> semantic null;
  - durable target trimming and malformed-value rejection;
  - stale inherited alias removal for no-target descendants and explicit child override.
- `tools/verify-devexec-mission-constraint-continuation.ps1` now syntax-checks the shared helper and includes both target-normalization regression files in the focused Mission bundle.

## Validation actually performed in cloud

- GitHub branch/file readback confirms the helper, launcher integration, goal integration, tests, verifier update, and this document are persisted on the dedicated branch.
- Exact reconstructed `devexec-target-alias.mjs` source: `node --check` PASS and helper tests 3/3 PASS.
- Focused launch preflight ordering probe: `MISSION_TARGET_PREFLIGHT_SEMANTIC_PROBE=PASS`.
- A real repository checkout was attempted, but the cloud container could not resolve `github.com`; therefore the repository test bundle was not executed here.
- GitHub combined CI status is checked separately at handoff. No Windows or SHIRO-WS PASS is claimed.

## Remaining acceptance

On a real checkout run `tools/verify-devexec-mission-constraint-continuation.ps1`. On SHIRO-WS preserve the existing continuation crash matrix and additionally prove:

1. targeted parent -> untargeted child has no effective target after `devexec-goal.mjs` entry and no stale target reaches Local Agent / Supervisor descendants;
2. targeted parent -> explicitly targeted child retains the exact child alias across child and grandchild continuation;
3. whitespace-only explicit `--target` is rejected before Local Agent start;
4. malformed durable PENDING target state is rejected without moving to LAUNCHING or spawning a child;
5. constraint non-leak and target isolation remain true at objective write, PENDING, LAUNCHING/spawn-before-receipt, and LAUNCHED-before-attach restart windows.

Do not broaden to live `GOAL_PATCH` / `supersede_current_goal` until Mission continuation reliability and host acceptance are closed. After that, continue the staged Control API/service work before GUI.
