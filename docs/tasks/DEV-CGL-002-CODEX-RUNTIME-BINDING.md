# DEV-CGL-002 — Explicit Codex runtime binding

Read first:

- `docs/tasks/DEV-CGL-001-SAME-TASK-RETURN.md`
- `tools/devexec-codex-continuation.mjs`
- `tools/devexec-codex-continuation.test.mjs`
- `docs/DEVEXEC_CONCURRENT_RELAY_SAFETY.md`

## Goal

Remove PATH-dependent Codex selection from unattended continuation.

The host currently exposes more than one Codex installation and their capabilities differ. Full Relay must never test with one Codex binary and later inject a prompt through another merely because PowerShell/Node/PATH resolution differs.

Implement a small parent-owned immutable Codex runtime binding and use it as the only runtime authority for autonomous same-task continuation.

Do not implement Full Relay in this slice.

## Core invariant

At task/session admission, Dev Exec selects and verifies one exact Codex runtime. After that point, queue/resume operations must invoke that exact runtime identity directly.

No later `codex` PATH lookup, shell alias, PowerShell command resolution, `where` result, npm default, or process-global current binary may change the runtime for the task.

If the bound runtime drifts or becomes unavailable, fail closed. Do not silently fall back to another installed Codex.

## Runtime binding

Add a compact protocol such as `devexec.codex-runtime-binding` v1.

Its exact shape may be chosen during implementation, but it must bind enough immutable parent-owned evidence to distinguish the actual executable/invocation used, including at least:

- exact absolute launch path or exact immutable launch vector
- observed Codex version
- observed continuation capabilities, at minimum `queue` and `resume`
- a deterministic runtime binding ID
- executable/launcher fingerprint sufficient to detect replacement/drift of the bound launch target
- bound timestamp/provenance

If the Windows launch target is a shim/script rather than a native executable, inspect the actual local installation and bind/verify enough launch identity that changing the underlying Codex implementation cannot be silently accepted just because a stable shim path remains.

Do not hardcode a machine-specific absolute path in Git. The path is runtime state/evidence.

## Admission / discovery

A controlled discovery/probe helper may enumerate installed candidates for diagnostics, but autonomous operation must explicitly choose one candidate and freeze it before continuation begins.

Prefer an explicit configured runtime input (for example an absolute path supplied by Dev Exec/runtime configuration) over implicit PATH selection.

If no acceptable runtime is explicitly bound, fail with a typed error rather than selecting whichever `codex` happens to resolve first.

The binding should make later Full Relay capable of requiring `queue` support without switching binaries.

## Invocation integration

Integrate minimally with `devexec-codex-continuation.mjs` so autonomous queue/resume invocation can be constructed from the validated runtime binding instead of default `command = "codex"`.

Requirements:

- queue uses the exact bound runtime and exact bound Codex thread ID
- resume, if retained, uses the same exact bound runtime
- a runtime lacking required capability returns a typed fail-closed error
- runtime drift between binding and use returns a typed fail-closed error
- no fallback to another binary after a capability/runtime failure
- preserve CGL001 task/thread dedupe and concurrency behavior

Keep process probing/invocation behind narrow adapters so most tests are deterministic without depending on the host installation.

## Real host probe

Perform a bounded read-only probe of the installed Codex candidates on SHIRO-WS if practical.

Record, without modifying either installation:

- exact resolved candidate paths/launch vectors
- versions
- whether `queue` is present
- whether `resume` is present
- which candidate should be explicitly bound for the next Full Relay slice and why

Do not update/install/downgrade Codex in this task.

## Tests

Prove at least:

1. Binding an explicit runtime produces deterministic canonical identity.
2. Two different runtime paths/versions/capability sets cannot share one binding identity.
3. Autonomous invocation uses the bound absolute runtime, not `codex` from PATH.
4. Changing PATH after binding does not change the invocation target.
5. Runtime fingerprint/version drift is rejected.
6. Missing bound runtime is rejected; no fallback occurs.
7. Missing required `queue` capability is rejected without switching to another installed runtime.
8. Task A and Task B may have distinct runtime bindings without cross-routing.
9. Concurrent continuation calls preserve their own runtime + thread bindings.
10. Existing CGL001 duplicate-return protection still allows at most one injection for one return identity.
11. Existing target-binding and continuation tests remain green.

## Constraints

- use the dedicated clean worktree for this branch
- do not modify dirty `probe/windows-local`
- do not modify/install Codex itself
- do not hardcode local machine paths in committed source/config
- do not implement ChatGPT transport or Local Relay yet
- do not reintroduce `--last`, mutable current session, mutable current target, or PATH-based runtime authority
- preserve CGL000/CGL001 semantics and concurrent-task safety

## Done when

- explicit Codex runtime binding/validation seam exists
- same-task continuation can be built against one exact verified runtime identity
- PATH/runtime drift cannot silently select another Codex
- focused tests pass
- `npm run build` passes
- relevant/full Dev Exec tests pass
- bounded real host probe identifies the candidate/runtime requirements for Full Relay
- final report contains exact branch/HEAD, changed files, tests, candidate paths/versions/capabilities, selected next runtime policy, and any concrete blocker

Stop after this slice. Do not implement Full Relay yet.
