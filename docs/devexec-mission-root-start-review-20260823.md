# Dev Exec Mission root-start replay-safety review — 2026-08-23

Status: review/continuation branch; not merged; host acceptance not run.

## Starting authority

Reviewed Worker A branch `automation/devexec-mission-concurrency-hardening-20260823` at exact SHA `c9334bc8253acd4230c200b32ebc243c85c618ee` after confirming the branch had not advanced.

Worker A had correctly fenced child Mission entry as `RESERVED -> STARTING -> ACTIVE | AMBIGUOUS` before `local-agent-facade start`, but the root Mission entry remained asymmetric: `startMissionLocalAgent()` created/opened the root Mission and then called the Local Agent start side effect without a durable start-attempt fence.

## Defect

If the root Local Agent start throws, returns an unreadable result, or the process loses the result after the side effect may have occurred, Mission state contained no durable `STARTING` / attempt identity / `AMBIGUOUS` evidence. Re-entering the same root Mission could therefore call the Local Agent start side effect again.

This is a replay-safety defect in the same class already closed for child entry. It is especially relevant before self-launch becomes a normal control-plane path.

## Repair on this branch

Branch: `automation/devexec-mission-root-start-fence-review-20260823`

Added root-run admission functions in `tools/devexec-mission-run-admission.mjs`:

- `beginMissionRootRunStart()` — statusless root -> `STARTING`, with durable `start_attempt_id` before the side effect;
- `activateMissionRootRun()` — matching `STARTING` attempt -> `ACTIVE` only after a validated Local Agent result;
- `markMissionRootRunAmbiguous()` — matching `STARTING` attempt -> `AMBIGUOUS` when start result is failed/unreadable;
- repeated/different attempts fail closed; `AMBIGUOUS` and `ACTIVE` roots are not automatically started again.

Rewired the root path in `tools/devexec-mission-entry-runtime.mjs` to use the same pre-side-effect fence pattern as child entry. The original `mission.created` result is preserved after the final durable readback.

Added `tools/devexec-mission-root-start-review.test.mjs` with desired-behavior regressions for STARTING-before-side-effect / ACTIVE-after-success and ambiguous-start no-replay.

## Validation actually performed

A source-faithful Node reconstruction of the modified root admission/entry semantics passed 3/3 targeted behavior tests, including an async-style invalid start result becoming ambiguous. Syntax validation of the reconstructed modified modules passed.

This is not repository-checkout CI and not Windows/SHIRO-WS host proof. GitHub exposes no combined statuses for the reviewed checkpoints.

## Adjacent safe-boundary review

The next requested staging seam is Mission amendment application in `tools/dev-exec-loop.mjs`. The code has the expected safe decision point: after the PowerShell result is persisted, `state.pending` is cleared and state is saved, immediately before `inspectLocalAgentGoalCompletion()` may terminally mark the run complete.

The repository already had a durable amendment queue and two-phase `PENDING -> APPLYING -> APPLIED` fence, but no durable typed mutation target. Marking an amendment `APPLIED` merely because the loop reached the safe point would therefore be false evidence.

### Durable mutation target added

This branch now adds `tools/devexec-mission-objective.mjs` as a deliberately small Mission-level mutation target for the safe subset of ordinary additions:

- supports `MISSION_AMENDMENT` only;
- supports `next_safe_boundary` and `after_current_goal` only;
- accepts only `add_work`, `constraint`, and `constraints` payload fields;
- persists `queued_work`, `constraints`, and an amendment/apply-attempt receipt in `mission-objective.json`;
- repeat of the same `amendment_id + apply_attempt_id + payload` is idempotent;
- changed attempt or payload for an already-recorded amendment fails closed;
- `GOAL_PATCH`, `supersede_current_goal`, and unknown payload keys remain unsupported rather than being falsely applied.

`tools/devexec-mission-amendment-runtime.mjs` composes the existing two-phase amendment fence with this objective target:

1. persist `APPLYING` and attempt identity;
2. perform the idempotent durable objective mutation and receipt;
3. only then mark the amendment `APPLIED`;
4. after a restart, an `APPLYING` amendment can safely retry the objective mutation: an existing matching receipt deduplicates, while a missing receipt creates the mutation once, then the same attempt completes.

Targeted validation performed in the cloud: exact Mission-objective module semantics **5/5 PASS**; amendment-runtime orchestration reconstruction **5/5 PASS** plus `node --check` PASS. The committed repository test files are `tools/devexec-mission-objective.test.mjs` and `tools/devexec-mission-amendment-runtime.test.mjs`. These are still not a real checkout/CI result.

### What remains intentionally unsupported

`local-agent-facade.mjs` persists a root `goal` string and `local-worker-adapter.mjs` persists a worker `mission` string, but neither exposes a safe live Goal-replacement operation. Therefore this branch does **not** pretend that a `GOAL_PATCH` or `supersede_current_goal` can mutate an already-running Local Agent. Those items stay PENDING until an explicit replay-safe current-Goal transition is implemented.

Similarly, applying `{add_work: ...}` to `mission-objective.json` is not yet sufficient to terminally complete the current run: the queued work still needs a continuation consumer. Production loop wiring must pair `after_current_goal` with a deterministic next-run/child-launch path or another explicit consumer before suppressing/allowing terminal COMPLETE.

## Next action

1. Reconcile this branch onto the latest continuation head after review and run the real repository Mission tests.
2. Connect the objective/amendment runtime at the post-result safe boundary, but only for the supported Mission-level additions and with fresh Mission control readback.
3. Before terminal Local Agent COMPLETE, if `after_current_goal` created queued work, hand that work to the existing duplicate-safe child-launch path with a durable consumption/launch receipt; do not drop it or merely report APPLIED.
4. Keep `GOAL_PATCH` / `supersede_current_goal` PENDING until a typed current-Goal transition exists.
5. On SHIRO-WS, add root `STARTING` kill/restart to the existing concurrent-writer and child-launch crash acceptance packet and prove the Local Agent side effect is not replayed.
