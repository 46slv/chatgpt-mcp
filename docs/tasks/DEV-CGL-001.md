# DEV-CGL-001 — Closed Goal Loop Phase 1 protocol seam

Read first: `docs/DEVEXEC_CODEX_CLOSED_GOAL_LOOP.md`.

## Goal

Implement Phase 1 only: a deterministic, model-independent protocol seam that proves completion → supervisor directive → next Codex task lineage for two consecutive outer-loop cycles.

## Scope

Implement the smallest reusable seam for:

- strict validation/canonicalization of `devexec.worker-completion` v1
- strict validation/canonicalization of `devexec.supervisor-directive` v1
- strict validation/canonicalization of `devexec.codex-task` v1
- parent-owned deterministic completion hashing
- completion → directive lineage validation via `parent_completion_hash`
- directive → task lineage validation via `parent_directive_id`
- same-identity same-payload idempotency
- same-identity conflicting-payload fail-closed behavior
- duplicate dispatch prevention at the pure contract/state seam

Add deterministic tests for:

1. Completion A → `CONTINUE` → Task B → Completion B → `STOP`.
2. Stale/mismatched `parent_completion_hash` is rejected.
3. Stale/mismatched `parent_directive_id` is rejected.
4. Identical replay is idempotent and does not create a second dispatch.
5. Conflicting reuse of an existing identity is rejected.
6. Completion hash is stable for canonical equivalent input and changes for a semantic payload change.

## Constraints

- Reuse existing Dev Exec conventions and seams.
- Do not create a second orchestration/control plane.
- Prefer a small pure module plus tests. Do not refactor `tools/dev-exec-loop.mjs` unless the contract seam demonstrably requires it.
- No real `codex exec` or `codex-ephemeral-harness` invocation in this slice.
- No real ChatGPT Web transport in this slice.
- No daemon, scheduler, queue, fairness, or general multi-agent framework.
- Do not change Local Worker planner behavior.
- Models do not own canonical Mission state, completion state, hashes, or dispatch identity.
- Identity/lineage ambiguity is fail-closed.
- Preserve existing lease/recovery/transport behavior.

## Suggested starting points

- `tools/dev-exec-loop.mjs`
- `tools/devexec-mission-supervisor-envelope.mjs`
- `tools/mission-supervisor-io.mjs`
- `tools/local-worker-iterative-runner.mjs`
- `tools/local-worker-adapter.mjs`
- `tools/local-run-ledger.mjs`
- `tools/local-runtime-recovery-journal.mjs`

Do not copy their state machines. Reuse their conventions and keep the new seam composable.

## Done when

- Phase 1 protocol seam exists with focused tests.
- `npm run build` passes.
- focused new tests pass.
- existing relevant Dev Exec tests pass; run the broad Dev Exec suite if practical.
- changed paths remain bounded to the new protocol seam/tests plus only minimal necessary integration.
- no real external transport/model/Codex side effects were introduced.
- final report contains exact branch/HEAD, changed files, tests, and any concrete Phase 2 blocker.

Stop after Phase 1. Do not start the Codex Worker adapter yet.
