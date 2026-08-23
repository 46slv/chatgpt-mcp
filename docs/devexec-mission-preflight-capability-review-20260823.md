# Dev Exec Mission launch preflight capability review — 2026-08-23

Status: **review/repair branch; connector readback + regression code committed; real-checkout/host verification still required**

Base: `automation/devexec-mission-atomic-preflight-20260823@643bb10985020ea3d366cef6e1197817166d7dfe`.

## Finding 1 — callback-shaped atomic preflight was too broad

Worker A correctly closed the launch-state TOCTOU by moving deterministic launch-spec validation into the same Mission lock/snapshot as `PENDING -> LAUNCHING`. The remaining concern was the API shape: `beginMissionChildLaunch()` accepted an arbitrary synchronous `preflight` callback and executed caller code while the Mission lock was held before the durable transition.

A future caller could perform an unrelated filesystem/process side effect in that callback and then throw, leaving the launch `PENDING` while an unjournaled side effect had already occurred. The current Worker A dispatcher supplied a pure spec builder, so this was a capability/regression risk rather than evidence of an already-observed duplicate process.

## Repair 1 — declarative atomic dispatch preflight

The review first prototyped a one-shot trusted callback capability, then narrowed the surface further: callback execution was removed entirely.

`beginMissionChildLaunch()` now accepts only declarative `dispatch_preflight: {entry_path, node_path}` data. The legacy callback option is explicitly rejected with `MISSION_LAUNCH_CALLBACK_PREFLIGHT_FORBIDDEN`, and malformed descriptors are rejected before launch mutation. `dispatchMissionChildLaunch()` passes only that declarative descriptor.

## Finding 2 — durable launch identity fields were incompletely revalidated

The atomic preflight validated target alias, constraints, node path, entry path, mission equality, and status, but copied durable `goal`, `parent_run_id`, and `child_run_id` into argv/environment without applying the request-time identity checks.

A corrupt/legacy PENDING record could therefore carry an invalid or stale Goal/lineage far enough to create `LAUNCHING` and approach spawn even though the original request contract would have rejected it.

## Repair 2 — durable Goal/lineage validation in the atomic spec builder

`buildMissionChildLaunchSpec()` now validates the exact durable snapshot before transition:

- `mission_id` is required and must match the control Mission;
- `parent_run_id` is required and must equal the current Mission run;
- `child_run_id` is required and must not already exist in `control.state.runs`;
- `goal` is required and normalized with the same non-empty-string rule used at request time;
- existing status, constraints, target, entry path, and node path validation remains.

Only validated values are emitted into argv/environment.

## Finding 3 — “declarative” objects can still execute caller code through accessors/Proxy traps

Moving from a callback to an object removed the obvious executable hook, but reading `dispatch_preflight.entry_path` / `.node_path` while the Mission lock was held could still invoke a getter or Proxy trap. A caller-controlled accessor could therefore perform an unrelated side effect inside the supposedly pure atomic section.

## Repair 3 — sanitize descriptor before acquiring the Mission lock

`beginMissionChildLaunch()` now reads and normalizes all caller-controlled preflight fields before calling `withLaunchStateLock()`. Only primitive normalized strings cross the lock boundary. Durable launch validation and spec construction remain inside the lock against the exact current launch snapshot, preserving Worker A's TOCTOU repair without permitting callback/accessor execution inside the atomic section.

A regression uses an accessor that checks for `mission-control.lock` and throws a sentinel error; the intended result is that the accessor observes no lock, the lock is absent after failure, and launch state remains PENDING with no attempt metadata.

## Regression

`tools/devexec-mission-target-validation.test.mjs` now covers:

1. malformed durable target/constraints/entry data remains PENDING and never reaches spawn;
2. blank durable Goal, blank/null lineage IDs, stale non-empty parent ID, and already-existing child ID remain PENDING with no attempt/request/lease metadata and zero spawn calls;
3. declarative dispatch preflight validates the exact durable snapshot before transition;
4. legacy synchronous and async callback preflights are rejected before invocation and transition;
5. malformed declarative descriptors are rejected before transition;
6. descriptor accessors are evaluated before Mission-lock acquisition;
7. canonical target/idempotency and the valid synthetic spawn-boundary path remain covered.

The existing `tools/verify-devexec-mission-constraint-continuation.ps1` already syntax-checks the modified launch/launcher modules and runs this test file, so the real-checkout acceptance entrypoint remains unchanged.

## Validation actually performed

- Worker A head was re-fetched immediately before branching and remained exact `643bb10985020ea3d366cef6e1197817166d7dfe` during review.
- Every GitHub write was surrounded by branch-head comparison/readback; Worker A history was not rewritten.
- Direct cloud `git clone` again failed at DNS resolution for `github.com`. Therefore repository-checkout tests, GitHub CI, Windows/SHIRO-WS, real child process, and process-kill/restart acceptance are **not** claimed as PASS.
- A focused source-faithful semantic reconstruction covering callback rejection, invalid durable Goal/lineage/constraints, PENDING preservation, and valid declarative transition actually ran and returned `MISSION_DECLARATIVE_PREFLIGHT_SEMANTIC_PROBE=PASS`.
- GitHub regression code for the real Mission lock/accessor case is committed but still requires execution by the real-checkout verifier.

## Remaining acceptance

On a real checkout run `tools/verify-devexec-mission-constraint-continuation.ps1` at the final review head. On SHIRO-WS continue the existing target/constraint/crash matrix and add malformed durable Goal/parent/child identity, concurrent/stale-writer launch preflight, and accessor/callback boundary cases. Prove invalid durable records create neither `LAUNCHING` metadata nor a child process. Keep live `GOAL_PATCH / supersede_current_goal` PENDING until Mission continuation reliability acceptance closes, then resume staged Control API/service work before GUI.
