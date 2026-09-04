# DEV-CGL-000 — Task-bound ChatGPT target safety seam

This task is now the first implementation slice for the Codex ↔ Local Relay ↔ ChatGPT closed loop.

Read first:

- `docs/DEVEXEC_TASK_BOUND_CHAT_TARGET.md`
- `tools/target-registry.mjs`
- `tools/target-registry.test.mjs`
- `tools/dev-exec-loop.mjs`

Do not start `DEV-CGL-001` until this task is complete. The older `DEV-CGL-001` task packet reflects an earlier design and is subordinate to `DEVEXEC_TASK_BOUND_CHAT_TARGET.md` for target-routing and same-task relay semantics.

## Goal

Implement a pure, deterministic task-bound ChatGPT target contract so an unattended Codex completion can never silently fall back to an old/default/project/legacy target.

No real ChatGPT send and no real Codex invocation in this slice.

## Required contract

Add a small reusable module for an immutable parent-owned task target binding, for example `devexec.task-chat-binding` v1.

Minimum semantics:

- mission/task identity
- canonical exact ChatGPT URL
- matching conversation ID
- provenance/source metadata
- deterministic parent-owned binding ID/hash
- validation that a relay report target exactly matches the stored binding
- no target selection from a mutable registry after admission

Reuse strict URL parsing from `target-registry.mjs` rather than duplicating URL rules.

## Critical rule

The new autonomous seam must not call ordinary fallback `resolveTarget()` after a task binding exists.

Interactive registry behavior remains unchanged. Do not delete or weaken manual CLI fallback support.

## Tests

Prove at least:

1. Task A is bound to Chat A.
2. A fixture default target points to old/wrong Chat X; Task A remains Chat A.
3. Changing the default after admission does not change Task A.
4. Remapping the source alias after admission does not change Task A.
5. Missing binding fails closed; there is no fallback.
6. Report with wrong binding ID fails closed.
7. Report with wrong URL or conversation ID fails closed.
8. Task A/Chat A and Task B/Chat B cannot cross-route.
9. Binding hash is deterministic for canonical equivalent input.
10. Semantic binding changes produce a different hash.

The pure seam should be testable without CDP, browser, model, or network access.

## Constraints

- one small module + focused tests preferred
- do not create a second registry or orchestration state machine
- do not change Local Worker planner behavior
- do not invoke ChatGPT Web
- do not invoke Codex
- do not introduce daemon/scheduler/queue behavior
- fail closed on missing/mismatched identity
- preserve current target registry CLI/manual behavior

## Done when

- focused target-binding tests pass
- `npm run build` passes
- relevant existing target-registry tests pass
- no regression to manual target operations
- final report includes branch, exact HEAD, changed files, tests, and next blocker

Stop after this slice.
