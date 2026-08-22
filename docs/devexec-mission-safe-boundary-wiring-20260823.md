# Dev Exec Mission safe-boundary continuation wiring — 2026-08-23

Status: cloud implementation checkpoint; host acceptance not yet run.

Base reviewed: `automation/devexec-mission-root-start-fence-review-20260823@3ac873d25a14cf8166c2e46014042371e7f45d2c`.

## Implemented

- Added `devexec-mission-loop-boundary.mjs` as the production-safe boundary adapter.
  - Applies only the already-supported `MISSION_AMENDMENT` mutation target through the existing two-phase `PENDING -> APPLYING -> APPLIED` runtime.
  - Leaves unsupported `GOAL_PATCH`, `supersede_current_goal`, and unknown mutation targets pending/skipped rather than inventing live Goal replacement semantics.
  - Converts durable `queued_work` into deterministic, idempotent child-launch intents only when the current goal is complete and no action is pending/ambiguous.
  - Tracks queued work by the objective receipt idempotency key so work is not re-consumed by later child RUNs. Multiple queued items chain one-at-a-time across child runs.
- Wired the adapter into both completion paths:
  - escalated/supervised completion through `inspectLocalAgentGoalCompletion()` at the existing post-result seam used by `dev-exec-loop.mjs`;
  - immediate Local Agent `COMPLETE` in `devexec-goal.mjs`, which previously exited before the supervisor loop and therefore bypassed the seam.
- Added `devexec-mission-continuation-dispatch.mjs`.
  - A durable launch intent must exist before dispatch.
  - `PENDING` dispatch uses the existing two-phase Mission launcher.
  - `LAUNCHING`/`AMBIGUOUS` is fail-closed; it is never respawned automatically.
  - `LAUNCHED`/`CONFIRMED` is treated as an already-crossed side-effect boundary and returned without another spawn.
  - A small synchronous wrapper lets the existing synchronous completion seam wait for the isolated async dispatcher before returning terminal `COMPLETE`.
- Extended `dispatchMissionChildLaunch()` with an optional `spawn_env` and explicitly carries the Mission `base` as `LOCALAPPDATA` into continuation children. Existing callers retain the previous default `process.env` behavior.

## Regression coverage added

- `devexec-mission-loop-boundary.test.mjs`
  - `next_safe_boundary` supported constraint application;
  - `after_current_goal` remains pending before completion;
  - deterministic/idempotent child-launch intent;
  - no re-consumption of completed objective work;
  - multiple queued work items chain sequentially across child RUNs;
  - unsupported `GOAL_PATCH` remains pending.
- `devexec-local-agent-mission-boundary.test.mjs`
  - durable amendment + launch intent + dispatch occurs before terminal completion is returned;
  - dispatch failure aborts completion and leaves durable APPLIED/PENDING evidence for recovery;
  - incomplete Local Agent does not dispatch `after_current_goal` work.
- `devexec-mission-continuation-dispatch.test.mjs`
  - child launch inherits the exact Mission base;
  - `LAUNCHING` replay is fail-closed;
  - synchronous wrapper preserves one structured payload/receipt.

## Validation actually performed in this cloud run

- GitHub branch/file/commit writes were read back through the GitHub connector.
- New helper and supervised completion modules passed `node --check` in an isolated container reconstruction.
- A source-faithful isolated Mission-boundary harness passed deterministic/idempotent replay and multi-child queued-work chaining semantics.
- Attempted a real checkout with `git clone` twice; both attempts were blocked by container DNS (`Could not resolve host: github.com`). Therefore the repository test files above were **not** executed against a real checkout and no GitHub CI result is claimed.

## Host acceptance still required

On SHIRO-WS, from this branch:

1. Run existing Mission suites plus:
   - `node --test tools/devexec-mission-loop-boundary.test.mjs`
   - `node --test tools/devexec-local-agent-mission-boundary.test.mjs`
   - `node --test tools/devexec-mission-continuation-dispatch.test.mjs`
2. Exercise a real `after_current_goal` amendment and verify, in order:
   - amendment becomes `APPLYING`, objective receipt is durable, then `APPLIED`;
   - child launch becomes `PENDING -> LAUNCHING -> LAUNCHED/CONFIRMED`;
   - child inherits `MISSION_ID`, `PARENT_RUN_ID`, deterministic child RUN id, target alias when present, and the same `LOCALAPPDATA` base;
   - parent terminal completion is not recorded before dispatch succeeds or is safely recognized as already launched.
3. Kill the parent at each boundary:
   - after objective write but before APPLIED;
   - after launch PENDING but before dispatcher;
   - after LAUNCHING/spawn but before receipt;
   - after LAUNCHED but before child attachment.
   Confirm no duplicate Local Agent/child RUN is spawned and ambiguous in-flight state remains fail-closed.
4. Queue two `after_current_goal` `add_work` amendments and verify they launch sequential child RUNs exactly once each.

## Remaining design boundary

`GOAL_PATCH` / `supersede_current_goal` intentionally remains unsupported. The next implementation should define a typed, replay-safe mutation of the live Goal/constraints before changing that disposition. Do not map an arbitrary patch payload directly into active Local Agent state.
