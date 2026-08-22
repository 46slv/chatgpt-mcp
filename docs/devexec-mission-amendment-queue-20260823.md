# Dev Exec durable Mission Amendment queue — 2026-08-23

Status: **Mission-root control core implemented/tested in cloud; `dev-exec-loop.mjs` runtime wiring not yet activated**

Branch: `automation/devexec-mission-amendment-queue-20260823`, based on exact `automation/local-worker-action-identity-20260823@28828eeb4fc9258838ecd3c1325c43d609e785fa`.

## Implemented contract

`tools/devexec-mission-amendments.mjs` provides a persistent queue for operator/supervisor work added while a Mission is active.

Supported input kinds:
- `MISSION_AMENDMENT`
- `GOAL_PATCH`

Supported apply modes:
- `next_safe_boundary`
- `after_current_goal`
- `supersede_current_goal`

Each item has a durable amendment ID, idempotency key, priority, payload, creation run identity, status, disposition reason, apply-attempt identity, apply-start timestamp, applied timestamp, and applied run identity. Queue revision advances on real mutations.

Repeated delivery with the same idempotency key and the same semantic request is deduplicated without revision churn. Reusing the same idempotency key for a changed request fails closed with `IDEMPOTENCY_KEY_CONFLICT` instead of silently dropping or replacing work.

Pending items are atomically persisted using temp-write + rename and can be carried to a child run without changing their origin identity. `APPLIED`, `REJECTED`, and `CANCELLED` remain in the durable record for audit.

## Two-phase safe-boundary apply fence

Selection returns no amendment unless `boundary.safe === true`. It also returns no amendment while `pending_action` or `ambiguous_action` is true. `after_current_goal` is held until `current_goal_complete === true`. Applicable work is ordered by priority, then creation time.

A side-effecting apply should use the two-phase fence:

1. `beginAmendmentApply()` changes `PENDING -> APPLYING`, persists `apply_attempt_id`, timestamp, and target run, and removes the item from normal selection.
2. The caller persists the Goal/constraint mutation using that attempt/amendment identity as its idempotency authority.
3. Only after the mutation has durable evidence does `completeAmendmentApply()` change `APPLYING -> APPLIED`.

Restart while `APPLYING` is fail-closed. Repeating the same apply-attempt ID is recognized as the same in-flight application; a different attempt ID fails with `AMENDMENT_APPLY_IN_FLIGHT`. Completion with a mismatched attempt ID fails with `AMENDMENT_APPLY_ATTEMPT_MISMATCH`.

This prevents a crash after mutation dispatch from making the amendment look pending and eligible for blind replay. It deliberately does not mutate an in-flight PowerShell action or reinterpret an ambiguous execution result.

## Durable Mission identity and lineage

`tools/devexec-mission-state.mjs` adds a canonical Mission root under `ChatGPTMCPProbe/dev-exec-missions/<mission_id>/` with:

- `mission-state.json`
- `amendments.json`
- reserved `launch-events.jsonl`

Mission/run IDs are path-safe; traversal-shaped IDs are rejected. Mission state records root/current run and child lineage. Child attachment requires a known parent, duplicate same-lineage attachment is idempotent, and reuse with a different parent fails `RUN_LINEAGE_CONFLICT`.

`tools/devexec-mission-control.mjs` joins Mission state and amendment state. It creates/reopens the Mission root, carries pending work into a child run, rejects a stale root run reclaim (`STALE_RUN_ID`) and a new sibling launch from a stale parent (`STALE_PARENT_RUN_ID`), durably enqueues amendments, and persists the two-phase apply fence before/after the external Goal mutation.

## Cloud validation

Executed against exact reconstructed current GitHub module semantics with Node:

- amendment queue baseline/idempotency/safe-boundary suite before the two-phase extension: **8/8 PASS**;
- focused two-phase apply/restart/idempotency guard: **4/4 PASS**;
- Mission identity/path/lineage persistence: **4/4 PASS**;
- Mission-control root/child/stale-lineage/two-phase persistence: **5/5 PASS**.

The checked-in final test files additionally encode the two-phase cases in `tools/devexec-mission-amendments.test.mjs` and the Mission-control cases in `tools/devexec-mission-control.test.mjs`. Full repository test-suite execution is not claimed in this cloud runtime.

## Verified integration seams in current Dev Exec loop

Fresh source inspection of `tools/dev-exec-loop.mjs` found three relevant boundaries:

1. Startup after persisted `state.pending` is checked and rejected: safe place to open Mission state, but not to resolve an ambiguous PowerShell execution.
2. After a local step result is durably attached, `state.pending` is cleared, and state phase becomes `STEP_PASS`/`STEP_FAIL`: primary `next_safe_boundary` integration point before the next supervisor round.
3. After `inspectLocalAgentGoalCompletion()` returns complete: candidate `after_current_goal` boundary before final completion/child-run planning.

The current production loop is still run-scoped and does not pass a canonical Mission ID into this new control surface. Therefore this branch does **not** yet modify `dev-exec-loop.mjs`. That avoids creating a half-wired authority path before Mission identity propagation and mutation receipts are defined end to end.

## Exact next implementation step

Wire Mission identity into the root entrypoint and child launch path: root runs create/receive `DEV_EXEC_MISSION_ID`; child runs inherit the same Mission ID and set `DEV_EXEC_PARENT_RUN_ID`. Open `devexec-mission-control` at startup. At each verified safe boundary, select an amendment and persist `APPLYING` before committing the concrete Goal/constraint mutation; the mutation artifact must carry amendment/apply-attempt identity, then complete the amendment only after readback.

After that vertical slice is proven, implement duplicate-safe self-launch using the same Mission root: durable launch intent, parent/child lineage, idempotency key, lease/lock, launch request identity, and launch receipt. A crash with an ambiguous launch must not issue another child launch until evidence is reconciled.

No production runtime wiring, host execution, merge, or publication is claimed by this branch.
