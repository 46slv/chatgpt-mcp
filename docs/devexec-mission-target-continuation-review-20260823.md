# Dev Exec Mission continuation target review — 2026-08-23

Status: Worker B review / non-merge implementation branch

Base reviewed: `automation/devexec-mission-safe-boundary-wiring-20260823@1e7245cfb7c6cb88b6867b13089a083d0c336957`.

## Finding 1: supervised continuations could lose the frozen target

Worker A correctly propagated `target_alias` through the immediate-COMPLETE path, but the supervised path wrote `local-agent-owner.json` without the target alias. Later, `inspectLocalAgentGoalCompletion()` called `applyMissionLoopBoundary()` without a target alias. The resulting child launch therefore had `target_alias: null`, and `buildMissionChildLaunchSpec()` omitted `DEV_EXEC_TARGET_ALIAS`.

This creates a routing-integrity defect: a parent RUN started with an explicit target can complete after a supervisor round and spawn its continuation without the same target, allowing registry/default target selection to diverge from the parent.

A second-generation variant existed as well. Child launches already carry `DEV_EXEC_TARGET_ALIAS` in the process environment, but `devexec-goal.mjs` initialized its local `target` only from `--target`. A child entered from the launcher could therefore inherit the correct environment for its own run yet lose the alias again when creating the next owner or continuation.

### Repair

1. Persist optional `target_alias` in the supervised `local-agent-owner.json`.
2. Validate the persisted alias when completion state is inspected. Missing aliases remain valid for backward compatibility; malformed non-empty values fail closed.
3. Forward the alias into `applyMissionLoopBoundary()` so the durable launch request retains it.
4. Initialize `devexec-goal.mjs` target state from inherited `DEV_EXEC_TARGET_ALIAS`, with `--target` still able to override it. This preserves target continuity across multiple child generations.
5. Extend `devexec-local-agent-mission-boundary.test.mjs` with explicit target propagation, legacy-owner compatibility, and malformed-target fail-closed coverage. The target test also checks that `buildMissionChildLaunchSpec()` emits `DEV_EXEC_TARGET_ALIAS`.

## Finding 2: persisted constraints were being reported APPLIED without runtime enforcement

`devexec-mission-objective.mjs` accepted `constraint` / `constraints`, durably stored them, and allowed the amendment runtime to mark them `APPLIED`. The reviewed execution path launches only `queued_work[].text`; no current path injects `objective.constraints` into the running Local Agent, supervisor envelope, or child Goal. The prior tests therefore proved persistence rather than behavioral enforcement.

For a reliability control this is unsafe: a constraint can appear accepted/applied while execution is unchanged.

### Repair

Until a typed constraint-consumption surface exists, any amendment carrying `constraint` or `constraints` is now unsupported at the objective mutation layer. `applyApplicableMissionObjectiveAmendments()` classifies it as `UNSUPPORTED_MUTATION_TARGET`, leaves the amendment `PENDING`, creates no objective receipt, and does not partially apply an accompanying `add_work`. This preserves atomicity and prevents a false APPLIED claim.

Tests were updated so ordinary `add_work` remains supported and deterministic, while constraint-only and mixed add-work-plus-constraint payloads fail closed/persist as PENDING.

## Finding 3: the committed multi-child chaining test skipped the real launch lifecycle

The previous chaining test attached the first child directly while its launch journal entry was still `PENDING`. That state cannot represent the production self-launch path: a child must cross `PENDING -> LAUNCHING -> LAUNCHED`, attach, and then reconcile to `CONFIRMED`. With the launch guard faithfully reconstructed, the old test failed on the second continuation with `MISSION_LAUNCH_ACTIVE` because the first synthetic launch was still active.

The test now models the production lifecycle explicitly: begin launch, complete launch with a receipt, attach the child, reconcile the launch to `CONFIRMED`, then request the next queued work. The same correction was applied to the root-work-not-reconsumed case. This makes sequential-chain coverage test the actual invariant rather than an impossible shortcut state.

## Validation actually performed

- GitHub branch HEAD was re-read before every write and remained unchanged from the expected preceding commit.
- Connector readback confirms the owner now contains `target_alias`, completion inspection validates/forwards it, inherited `DEV_EXEC_TARGET_ALIAS` initializes child target state, and the committed target regressions are present.
- A connector-fetched source-faithful reconstruction ran four focused suites against the reviewed semantics: Mission objective `5/5 PASS`, amendment-runtime `5/5 PASS`, loop-boundary including the real confirmed-child lifecycle `5/5 PASS`, and local-agent Mission boundary including target propagation `6/6 PASS` — **21/21 PASS** total.
- The same reconstruction exposed the old impossible-state chaining test before it was corrected: it failed at the second child with `MISSION_LAUNCH_ACTIVE`; after modeling `LAUNCHING -> LAUNCHED -> CONFIRMED`, the suite passed `5/5`.
- `node --check` also passed for the reconstructed modified goal-state and objective modules.
- A real repository checkout is still unavailable in the cloud container because `github.com` DNS resolution fails. Therefore these are connector-fetched source-faithful tests, not a real checkout or GitHub CI PASS, and no Windows/SHIRO-WS runtime proof is claimed.

## Host / checkout acceptance

1. Run all existing Mission suites plus the modified objective, loop-boundary, amendment-runtime, and local-agent mission-boundary tests from a real checkout.
2. Start a Mission with an explicit target that requires supervisor escalation, then enqueue `after_current_goal` work. Verify parent owner -> launch-state -> child environment all retain the exact target alias.
3. Let that child complete immediately and via supervisor on separate runs; verify a second continuation still retains the target.
4. Continue the existing kill/restart acceptance for objective write, PENDING launch, LAUNCHING/spawn-before-receipt, and LAUNCHED-before-child-attach. No duplicate child and no target drift are allowed.
5. Verify a constraint amendment stays PENDING and causes no side effect. Before enabling it later, implement a typed runtime constraint-consumption surface and prove the constraint affects the intended run/child across restart boundaries.
