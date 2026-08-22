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

## Validation actually performed

- GitHub branch HEAD was re-read before every write and remained unchanged from the expected preceding commit.
- Connector readback confirms the owner now contains `target_alias`, completion inspection validates/forwards it, inherited `DEV_EXEC_TARGET_ALIAS` initializes child target state, and the committed target regressions are present.
- A connector-fetched source-faithful Node harness executed the modified `devexec-local-agent-goal-state.mjs` with stubbed boundary/dispatcher dependencies: explicit alias propagation, legacy missing alias, and malformed alias fail-closed all passed (`3/3`). `node --check` passed for that exact reconstructed module.
- A second connector-fetched source-faithful harness executed the exact revised Mission objective semantics with the real lock/state helpers: constraint-only rejection, mixed add-work-plus-constraint rejection, and ordinary add-work durable receipt all passed (`3/3`). `node --check` passed for the reconstructed revised objective module.
- A real repository checkout is still unavailable in the cloud container because `github.com` DNS resolution fails. Therefore the committed repository test suite and GitHub CI are not claimed as PASS, and no Windows/SHIRO-WS runtime proof is claimed.

## Host / checkout acceptance

1. Run all existing Mission suites plus the modified objective, loop-boundary, and local-agent mission-boundary tests from a real checkout.
2. Start a Mission with an explicit target that requires supervisor escalation, then enqueue `after_current_goal` work. Verify parent owner -> launch-state -> child environment all retain the exact target alias.
3. Let that child complete immediately and via supervisor on separate runs; verify a second continuation still retains the target.
4. Continue the existing kill/restart acceptance for objective write, PENDING launch, LAUNCHING/spawn-before-receipt, and LAUNCHED-before-child-attach. No duplicate child and no target drift are allowed.
5. Verify a constraint amendment stays PENDING and causes no side effect. Before enabling it later, implement a typed runtime constraint-consumption surface and prove the constraint affects the intended run/child across restart boundaries.
