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

This is not repository-checkout CI and not Windows/SHIRO-WS host proof. GitHub exposes no combined statuses for the current branch checkpoint.

## Adjacent safe-boundary review

The next requested staging seam is Mission amendment application in `tools/dev-exec-loop.mjs`. The code has the expected safe decision point: after the PowerShell result is persisted, `state.pending` is cleared and state is saved, immediately before `inspectLocalAgentGoalCompletion()` may terminally mark the run complete.

However the repository currently has a durable amendment queue and two-phase `PENDING -> APPLYING -> APPLIED` fence, but no durable typed mutation target for a running Local Agent Goal/constraints. `local-agent-facade.mjs` persists `goal` into Local Agent state and `local-worker-adapter.mjs` persists `mission`, but neither exposes a safe live Goal-patch operation. The amendment tests intentionally use generic payload examples such as `{add_work: ...}` and `{constraint: ...}`; those examples do not define executable mutation semantics.

Therefore the loop should not mark an amendment `APPLIED` merely because it reached the safe point. Before production wiring, define and test the durable mutation target/readback contract. At minimum it must answer:

1. which payload fields are accepted for `MISSION_AMENDMENT` versus `GOAL_PATCH`;
2. whether a patch changes the current Local Agent run, only the next Goal/child RUN, or a Mission-level objective overlay;
3. what durable file/state is written before `completeMissionAmendmentApply()`;
4. how restart after `APPLYING` proves whether the mutation occurred without blindly replaying it;
5. how `after_current_goal` is consumed before terminal COMPLETE and converted into continued work/child launch;
6. how `supersede_current_goal` remains blocked while a typed action is pending or ambiguous.

Until that contract exists, the safe implementation boundary is to select/begin only when an executable durable mutation plan is known; otherwise leave the amendment `PENDING`, not falsely `APPLIED`.

## Next action

Reconcile this root-start fence onto the current continuation head after review, run the real repository Mission tests, then implement a small typed durable Mission objective/Goal-patch target with mutation receipt/readback and crash tests. Only then connect it to the post-result / pre-local-goal-COMPLETE seam in `dev-exec-loop.mjs`. Host acceptance should also kill/restart during root `STARTING` and prove the Local Agent side effect is not replayed.
