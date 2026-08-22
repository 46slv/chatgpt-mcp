# Dev Exec Mission runtime wiring / self-launch control — 2026-08-23

Status: **cloud implementation checkpoint; real Dev Exec loop/Windows acceptance pending**

Branch: `automation/devexec-mission-runtime-wiring-20260823`, based on exact `automation/devexec-mission-amendment-queue-20260823@e7c4f393ffee6d052ad4e25d0c3daddefea070b5`.

## Implemented in this checkpoint

- `tools/devexec-mission-entry.mjs` defines root/child Mission identity. A root defaults `mission_id` to its run ID; a child must inherit an explicit Mission ID and parent run ID.
- `tools/devexec-goal.mjs` now propagates `DEV_EXEC_MISSION_ID` / `DEV_EXEC_PARENT_RUN_ID`, opens the durable Mission root after a valid Local Agent start, attaches child lineage, and records Mission identity in the owner/result envelope.
- `tools/devexec-mission-amend.mjs` is a typed amendment ingress for an already-active Mission. It only accepts structured amendment fields and writes through `devexec-mission-control`; it does not expose arbitrary shell execution.
- `tools/devexec-mission-launch.mjs` adds durable duplicate-safe child launch intent: idempotency key, lineage, `PENDING -> LAUNCHING -> LAUNCHED -> CONFIRMED`, lease token/expiry, launcher request identity, receipt, and explicit `AMBIGUOUS` fail-closed state.
- `tools/devexec-mission-launcher.mjs` performs the real process-dispatch seam. `LAUNCHING` is durably persisted before `spawn`; only the Node `spawn` event permits a launch receipt. A spawn error becomes durable `AMBIGUOUS`, not replayable `PENDING`.
- Child launch specs carry `DEV_EXEC_MISSION_ID`, `DEV_EXEC_PARENT_RUN_ID`, `DEV_EXEC_RUN_ID`, and optional target alias into `devexec-goal.mjs`.

## Cloud validation actually run

Focused Node tests for the new entry/amend/launch/dispatcher modules: **11/11 PASS**. A consolidated checked-in regression suite covering the critical cases ran **8/8 PASS**.

A local stub-agent integration probe ran `devexec-goal.mjs --dry-run` for a root then child run and read back the Mission state plus both owner records: **PASS**. It proved the child inherited the root Mission and attached as lineage instead of creating a sibling Mission.

This does not claim the repository-wide suite, real Local Agent, real ChatGPT Bridge, Windows detached child lifetime, or the production `dev-exec-loop.mjs` safe-boundary wiring.

## Remaining critical integration

The existing production loop still needs to open Mission Control at startup and, after a step result is durably saved with no pending/ambiguous execution, consume applicable amendments using the existing two-phase apply fence. The concrete Goal/constraint mutation must carry amendment + apply-attempt identity and be read back before `APPLIED` is recorded. `after_current_goal` must be evaluated before the loop turns a completed Local Agent into terminal Mission completion.

After that, invoke the new launch request/dispatcher from the existing continuation decision path and reconcile `LAUNCHED` against the child Mission lineage. A process crash after OS spawn but before receipt must remain `LAUNCHING`/ambiguous and must not issue another child until reconciled.

## Host acceptance packet

1. Run the checked-in focused Node regression from a real checkout.
2. Run root `devexec-goal.mjs --dry-run`, then a child with inherited Mission/parent IDs; inspect `mission-state.json` and both owner files.
3. Dispatch one bounded child through `devexec-mission-launcher.mjs`; verify a single child PID, a durable receipt, child lineage attachment, and `CONFIRMED` reconciliation.
4. Kill the parent after the child process emits spawn but before receipt completion; restart and prove no duplicate child is launched.
5. Only after those checks should the production loop safe-boundary/self-continuation wiring be considered for merge.
