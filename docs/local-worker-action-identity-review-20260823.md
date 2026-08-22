# Local Worker action-identity replay-safety review — 2026-08-23

Status: **review clean for process-crash replay safety; live Local Executor / SHIRO-WS acceptance still required**

Reviewed implementation branch: `automation/local-worker-action-identity-20260823@28828eeb4fc9258838ecd3c1325c43d609e785fa`.
Continuation branch: `automation/local-worker-process-kill-replay-20260823`.

## Source audit

The actual adapter path supports the intended pre-dispatch fence:

1. `runIterativeLocalWorker()` / `runLocalWorkerResume()` append a record with `pending:true` and a stable worker request ID.
2. They await `onProgress(... pending:true ...)` before invoking `execute()`.
3. `local-worker-adapter.mjs` supplies `onProgress: async () => save(s)` for both start and resume.
4. `save(s)` synchronously writes JSON to a temporary file and renames it over the state file before returning.
5. The adapter does not supply a side-effecting `onBeforeExecute`; the runner default is a no-op.
6. On restart, both normal resume and repair validation reject any unresolved pending record with `AMBIGUOUS_ACTION_IN_FLIGHT` before planner or executor work. `consumeLocalWorkerRepair()` validates first and renames the repair file only after validation succeeds, so an ambiguous pending action does not consume the repair instruction.

This closes the process-crash replay gap at the source level: if the executor may have completed but result evidence was not attached, the last persisted state remains pending and later execution is fail-closed rather than replayed.

## Deterministic restart regressions

`tools/local-worker-restart-persistence.test.mjs` persists the pending action to a real temporary JSON file, simulates an executor-side effect followed by process loss, reloads the actions as a fresh process would, and proves `runLocalWorkerResume()` rejects before replanning or re-executing.

Independent Node execution of that regression in the prior cloud review environment: **1/1 PASS**.

`tools/local-worker-process-kill-restart.test.mjs` strengthens the proof by spawning a real child Node process. The child persists `pending:true`, enters `execute()`, writes a dispatch marker, and blocks. The parent waits until both durable pending state and dispatch evidence exist, terminates the process, reloads the state, and proves resume throws `AMBIGUOUS_ACTION_IN_FLIGHT: R01-01-001` before planner or executor code can run.

Independent Node execution against exact reconstructed `local-worker-iterative-runner.mjs` and `local-worker-resume-runtime.mjs` semantics: **1/1 PASS**. This is an actual OS process termination test, not a thrown-error simulation.

## Remaining boundaries

- The process-kill replay fence is now proven with a real child process in the cloud execution environment, but not yet on SHIRO-WS.
- The adapter's temp-write + rename is sufficient evidence for ordinary process-crash recovery semantics; this review does not claim power-loss/fsync durability.
- A live Local Executor request/result round trip on SHIRO-WS remains host-only acceptance.
- The focused action-identity, persistence, and process-kill regressions should be run from the real checkout to catch environment/module drift.

## Exact host validation

From the continuation branch, run the deterministic suite first:

`node --test tools/local-worker-action-identity.test.mjs tools/local-worker-restart-persistence.test.mjs tools/local-worker-process-kill-restart.test.mjs`

Then perform one bounded SHIRO-WS live Local Executor round trip using a disposable local-worker run. Preserve the worker request ID, executor request ID, pre/post state JSON, and result evidence. If a live forced termination is also performed, require the same pending fence and `AMBIGUOUS_ACTION_IN_FLIGHT` before any new planner/executor request.

Do not merge on cloud evidence alone; read back the SHIRO-WS checkout and live executor evidence first.
