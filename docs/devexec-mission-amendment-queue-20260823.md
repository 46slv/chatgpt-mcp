# Dev Exec durable Mission Amendment queue — 2026-08-23

Status: **core implemented/tested in cloud; runtime wiring not yet activated**

Branch: `automation/devexec-mission-amendment-queue-20260823`, based on exact `automation/local-worker-action-identity-20260823@28828eeb4fc9258838ecd3c1325c43d609e785fa`.

## Implemented contract

`tools/devexec-mission-amendments.mjs` provides a small persistent queue for operator/supervisor work added while a Mission is active.

Supported input kinds:
- `MISSION_AMENDMENT`
- `GOAL_PATCH`

Supported apply modes:
- `next_safe_boundary`
- `after_current_goal`
- `supersede_current_goal`

Each item has a durable amendment ID, idempotency key, priority, payload, creation run identity, status, disposition reason, applied timestamp, and applied run identity. Queue revision advances on real mutations.

Repeated delivery with the same idempotency key and the same semantic request is deduplicated without revision churn. Reusing the same idempotency key for a changed request fails closed with `IDEMPOTENCY_KEY_CONFLICT` instead of silently dropping or replacing work.

Pending items are atomically persisted using temp-write + rename and can be carried to a child run without changing their origin identity. `APPLIED`, `REJECTED`, and `CANCELLED` remain in the durable record for audit.

## Safe-boundary rule

Selection returns no amendment unless `boundary.safe === true`. It also returns no amendment while `pending_action` or `ambiguous_action` is true. `after_current_goal` is held until `current_goal_complete === true`. Applicable work is ordered by priority, then creation time.

This deliberately does not mutate an in-flight PowerShell action or reinterpret an ambiguous execution result.

## Cloud validation

Exact reconstructed module/test execution with Node: **8/8 PASS**.

Coverage includes:
- duplicate delivery dedupe;
- changed-request idempotency conflict;
- object-key-order-insensitive payload comparison;
- unsafe/pending/ambiguous boundary blocking;
- mode-specific safe-boundary selection;
- one-time apply disposition and run attribution;
- restart + child-run persistence;
- rejected/cancelled audit retention.

## Verified integration seams in current Dev Exec loop

Fresh source inspection of `tools/dev-exec-loop.mjs` found three relevant boundaries:

1. Startup after persisted `state.pending` is checked and rejected: safe place to load Mission amendments, but not to mark them applied before a concrete target/goal mutation commits.
2. After a local step result is durably attached, `state.pending` is cleared, and state phase becomes `STEP_PASS`/`STEP_FAIL`: primary `next_safe_boundary` integration point before the next supervisor round.
3. After `inspectLocalAgentGoalCompletion()` returns complete: candidate `after_current_goal` boundary before final completion/child-run planning.

The current loop has run-scoped state but no canonical Mission ID / Mission-root state path yet. Therefore this branch does **not** wire the queue into `dev-exec-loop.mjs`; doing so with a run-local path would violate the requirement that pending amendments survive child RUNs.

## Exact next implementation step

Introduce a canonical Mission identity/root owned by the control plane (for example `DEV_EXEC_MISSION_ID` plus a mission-state directory), then load/save one amendment queue at that Mission root. At each verified safe boundary, select applicable amendments, durably record the intended Goal/constraint mutation, then mark the amendment applied only after that mutation is persisted. Child-run launch must carry the same Mission ID and amendment path.

Self-launch should be implemented only after this Mission-root identity exists, because launch intent, lineage, idempotency key, lease/lock, and launch receipt need the same durable Mission authority.

No production runtime wiring, host execution, merge, or publication is claimed by this branch.
