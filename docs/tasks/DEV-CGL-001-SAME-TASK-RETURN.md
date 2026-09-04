# DEV-CGL-001 — Same-task Codex return seam

This task supersedes the older `docs/tasks/DEV-CGL-001.md` for continuation semantics.

Read first:

- `docs/DEVEXEC_TASK_BOUND_CHAT_TARGET.md`
- `docs/DEVEXEC_CONCURRENT_RELAY_SAFETY.md`
- `tools/devexec-task-chat-binding.mjs`
- `tools/devexec-task-chat-binding.test.mjs`
- current upstream Codex session continuation behavior before coding

## Goal

Implement the smallest deterministic seam that lets Dev Exec return a ChatGPT-produced prompt to the exact original Codex session/task instead of launching a new Codex task.

The contract must remain correct when multiple Codex tasks are active concurrently. This slice does not wire the full ChatGPT relay yet; it proves and guards same-task continuation identity, task-scoped dedupe, and non-cross-routing under concurrent callers.

## Required semantics

At Codex task admission/launch, Dev Exec must capture and persist the exact Codex session/thread identity that is allowed to receive later prompts.

Add a small immutable parent-owned continuation binding, e.g. `devexec.codex-continuation-binding` v1, with at least:

- mission/task identity
- exact Codex thread/session UUID
- working directory/repo identity as needed to prevent cross-task confusion
- created/bound timestamp
- deterministic parent-owned binding ID

The local model does not select or alter this identity.

## Return path

Preferred current Codex mechanism: use the existing same-session queue path when supported by the installed Codex runtime:

`codex queue --thread <EXACT_THREAD_ID> --message <PROMPT>`

Do not use `--last`, picker-based selection, session-name fuzzy matching, or any mutable default.

If a fallback continuation path using `codex exec resume <EXACT_THREAD_ID> ...` is implemented, it must be fail-closed:

- only persisted/non-ephemeral sessions are eligible
- parse the resumed run's reported `thread.started.thread_id`
- require exact equality with the bound thread ID before considering continuation successful
- a mismatched/new thread is `CONTINUATION_IDENTITY_MISMATCH`, never success
- nonexistent/stale/ephemeral IDs must never silently become a new accepted task

Prefer queue over resume when queue is available and appropriate.

## Pure seam first

Keep process invocation behind a narrow adapter so most behavior is deterministic and testable without invoking Codex.

Suggested operations:

- create/canonicalize continuation binding
- validate an incoming return request against that binding
- deterministic return/dedupe identity for one ChatGPT prompt
- adapter result validation proving the actual target thread equals the expected thread

## Idempotency

One ChatGPT reply must not be injected twice automatically.

Use a parent-owned return identity/dedupe key derived from stable fields such as:

- task/mission identity
- continuation binding ID
- supervisor/relay response identity or prompt hash

Rules:

- same identity + same payload: idempotent/no second injection
- same identity + different payload: hard conflict
- process/delivery ambiguity after injection begins: fail closed; no blind re-injection

## Concurrent Codex requirement

The seam must not rely on a process-global current task/current thread or one mutable singleton continuation target.

- Task A/thread A and Task B/thread B are independently bound and may be processed concurrently.
- A return request carries enough immutable identity to select exactly one continuation binding without consulting `--last`, current session, arrival order, or another task's state.
- Dedupe/reservation state is keyed by task/binding/return identity, not one global `IN_FLIGHT` flag.
- simultaneous callers for different thread bindings must not block or overwrite each other solely because they are concurrent.
- simultaneous duplicate callers for the same return identity must result in at most one external injection; the other attempt is idempotent/busy/fail-closed as appropriate.
- Task A's prompt can never be accepted against Task B's binding, even if both tasks share a repo or ChatGPT conversation.
- Do not implement the ChatGPT conversation send queue in this slice; that belongs to the later Full Relay slice and is specified in `docs/DEVEXEC_CONCURRENT_RELAY_SAFETY.md`.

## Tests

Prove at least:

1. Task A binds thread A; a prompt is targeted only to thread A.
2. Task A/thread A and Task B/thread B cannot cross-route.
3. Missing continuation binding fails closed.
4. Wrong thread/session ID fails closed.
5. Mutable `--last`/default selection is not used by the autonomous seam.
6. Same return identity/payload is idempotent and produces no second dispatch.
7. Same return identity with changed prompt is rejected.
8. A simulated continuation adapter returning a new/different thread ID is rejected.
9. Exact expected thread ID is accepted.
10. Binding/return hashes are deterministic.
11. Concurrent Task A/thread A and Task B/thread B return attempts preserve independent identities and target the correct threads.
12. Two simultaneous attempts for one return identity cannot both acquire/produce an external injection.
13. Concurrency tests do not depend on arrival order to associate prompt -> task/thread.

If a real local Codex probe is practical and non-destructive, add only a bounded probe that demonstrates the installed CLI's same-thread behavior. Do not require a real code mutation for the acceptance of this slice.

## Constraints

- do not start a new Codex session as the normal return path
- do not use `--last` for unattended routing
- do not use ephemeral sessions if they cannot be proven resumable
- do not use a process-global current task/current thread as routing authority
- do not modify the dirty `probe/windows-local` checkout
- continue in the dedicated clean worktree for this branch
- do not hardcode or commit the user's raw ChatGPT conversation URL; that remains runtime task-bound state
- do not wire the full local-model -> ChatGPT -> Codex loop yet
- do not change Local Worker planner semantics
- preserve DEV-CGL-000 target-binding behavior

## Done when

- same-task Codex continuation binding/validation seam exists
- task-scoped concurrent return attempts cannot cross-route or double-inject
- focused new tests pass
- `npm run build` passes
- relevant existing Dev Exec tests pass
- no duplicate/new-session behavior can be accepted as same-task continuation
- final report includes exact branch/HEAD, changed files, tests, whether local installed Codex supports queue/resume, concurrency findings, and the concrete next blocker

Stop after this slice. Do not implement the full ChatGPT transport/Local Relay yet.
