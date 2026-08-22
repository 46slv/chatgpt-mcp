# Local Worker action-identity replay-safety review — 2026-08-23

Status: **review clean for process-crash replay safety; host acceptance still required**

Reviewed branch: `automation/local-worker-action-identity-20260823@28828eeb4fc9258838ecd3c1325c43d609e785fa`.

## Source audit

The actual adapter path supports the intended pre-dispatch fence:

1. `runIterativeLocalWorker()` / `runLocalWorkerResume()` append a record with `pending:true` and a stable worker request ID.
2. They await `onProgress(... pending:true ...)` before invoking `execute()`.
3. `local-worker-adapter.mjs` supplies `onProgress: async () => save(s)` for both start and resume.
4. `save(s)` synchronously writes JSON to a temporary file and renames it over the state file before returning.
5. The adapter does not supply a side-effecting `onBeforeExecute`; the runner default is a no-op.
6. On restart, both normal resume and repair validation reject any unresolved pending record with `AMBIGUOUS_ACTION_IN_FLIGHT` before planner or executor work. `consumeLocalWorkerRepair()` validates first and renames the repair file only after validation succeeds, so an ambiguous pending action does not consume the repair instruction.

This closes the process-crash replay gap at the source level: if the executor may have completed but result evidence was not attached, the last persisted state remains pending and later execution is fail-closed rather than replayed.

## Added regression

`tools/local-worker-restart-persistence.test.mjs` persists the pending action to a real temporary JSON file, simulates an executor-side effect followed by process loss, reloads the actions as a fresh process would, and proves `runLocalWorkerResume()` rejects before replanning or re-executing.

Independent Node execution of this exact regression in the cloud review environment: **1/1 PASS**.

## Remaining boundaries

- The cloud test models process restart and filesystem persistence but is not an actual SHIRO-WS process kill.
- The adapter's temp-write + rename is sufficient evidence for process-crash recovery semantics; this review does not claim power-loss/fsync durability.
- A live Local Executor request/result round trip and an actual forced process termination between the pending-state save and result-state save remain host-only acceptance.
- The existing focused `local-worker-action-identity.test.mjs` should also be run from a real checkout together with the new persistence regression.

## Exact host validation

From the reviewed branch or this continuation branch, run the two deterministic tests first:

`node --test tools/local-worker-action-identity.test.mjs tools/local-worker-restart-persistence.test.mjs`

Then perform one bounded SHIRO-WS kill/restart probe using a disposable local-worker run: terminate the worker only after the persisted state visibly contains one `pending:true` action and after executor dispatch may have occurred, restart the same run, and require `AMBIGUOUS_ACTION_IN_FLIGHT` before any new planner/executor request. Preserve the pre/post state JSON and executor request IDs as evidence.

Do not merge on the basis of cloud review alone; read back the host evidence first.
