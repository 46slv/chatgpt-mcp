# DEV-CGL-004 — Real persisted-session E2E probe

This task is an operational validation and bounded repair slice for the already-implemented CGL000–003 closed-loop relay.

Read first:

- `docs/tasks/DEV-CGL-003-FULL-RELAY.md`
- `docs/DEVEXEC_TASK_BOUND_CHAT_TARGET.md`
- `docs/DEVEXEC_CONCURRENT_RELAY_SAFETY.md`
- `tools/devexec-full-relay.mjs`
- `tools/devexec-codex-continuation.mjs`
- `tools/devexec-codex-runtime-binding.mjs`
- `tools/devexec-task-chat-binding.mjs`

## Goal

Prove one real, harmless end-to-end round using a disposable **persisted** Codex session:

```text
safe persisted Codex probe thread
  -> exact completion/status relay payload
  -> Local Model RELAY gate
  -> runtime-provided exact ChatGPT conversation
  -> correlated devexec.codex-prompt response
  -> Local Model RELAY gate
  -> exact bound native codex.exe
  -> codex queue --thread <exact probe thread>
  -> proof that the exact same thread accepted the queued prompt
```

This task may make only the minimum bounded repairs needed for this real probe. It must not enable an unbounded automatic loop.

## Runtime-only ChatGPT target

The exact ChatGPT URL is supplied by the operator at runtime/bootstrap.

Do not write the real URL or conversation ID to tracked files, commits, fixtures, snapshots, or logs intended for Git.

Construct the `TaskChatBinding` from the exact runtime URL before the relay round. After binding, no `resolveTarget()`, `current-chat`, default alias, project config, legacy target env fallback, browser focus, or target re-resolution is permitted.

## Step 0 — preflight before any external relay send

Before creating an external ChatGPT side effect:

1. fresh-read the branch and confirm CGL003 remote state.
2. use the CGL002-bound native Codex runtime policy: exact absolute native `codex.exe`, empty launch-arg prefix unless the binding says otherwise, required `queue=true`, no npm/PowerShell/PATH fallback.
3. verify its version/capability/fingerprint using the existing runtime-binding seam.
4. inspect the installed native `codex queue` success output shape and compare it with `validateCodexContinuationResult`.
5. if the current validator cannot deterministically prove the exact thread from the native queue result, repair that parser/adapter **before** the real relay probe and add focused tests. Do not discover this only after injecting a real prompt.
6. verify the exact-target `chatgpt_reply` transport accepts `target_url` + `expected_conversation_id` as used by CGL003.
7. verify a real Local Model RELAY adapter/backend is available. It must use RELAY semantics only; do not invoke Local Worker AGENT planning.

If these preconditions cannot be proven, stop `REAL_PROBE_BLOCKED` without external ChatGPT send.

## Create a disposable persisted Codex probe session

Use only the bound native Codex runtime.

Create one new harmless persisted session/thread explicitly for this probe. Current upstream `codex exec` persists session files by default; `--ephemeral` is opt-in, so **do not use `--ephemeral`**. Confirm the installed native CLI behavior before relying on it.

Requirements:

- use a dedicated safe working directory or the dedicated clean worktree
- use read-only/no-write sandboxing where the installed CLI supports it
- the initial prompt must explicitly prohibit file edits, Git changes, network side effects, and subprocess side effects beyond what Codex itself requires
- ask only for a small deterministic readiness response
- capture the exact `thread.started.thread_id` from structured output
- prove the session is persisted/non-ephemeral before creating the continuation binding
- never use `--last`, fuzzy session name, picker selection, or another existing work session

Suggested harmless initial intent:

`This is a relay E2E probe. Do not modify files or run project-changing commands. Reply PROBE_READY and wait for a later queued message.`

The exact wording may be adjusted to the installed CLI, but the semantics must remain read-only and disposable.

## Real relay round

Create fresh runtime state for exactly one relay request using:

- runtime-only exact `TaskChatBinding`
- continuation binding for the newly-created persisted probe thread
- the CGL002 native runtime binding with `queue` required
- a minimal Codex relay report containing only bounded probe completion/status text

The Local Model must participate on both relay legs in CGL003 hash-only RELAY mode.

The report sent to ChatGPT must use the CGL003 correlated request envelope. There may be at most one real ChatGPT outbound request in this probe.

## Expected ChatGPT response

The ChatGPT conversation is expected to return exactly one `devexec.codex-prompt` envelope correlated to the received request.

For a successful probe, request `CONTINUE` with a harmless prompt equivalent to:

`This is the CGL004 E2E acknowledgement. Do not modify files. Reply exactly CGL004_PROBE_ACK <relay_request_id> and stop.`

The actual ChatGPT response must carry the exact incoming:

- `mission_id`
- `task_id`
- `relay_request_id`
- `report_sha256`

No response may be associated by arrival order.

## Codex return proof

Return the exact ChatGPT prompt bytes through the Local Model RELAY return gate and then through the CGL001/CGL002 continuation sender.

Required:

- native bound runtime only
- `queue` only
- exact probe `thread_id`
- runtime fingerprint reverified immediately before injection
- at most one queue injection
- no resume fallback
- no PATH/default/alternate binary

Prove the native queue result identifies the exact expected thread. If the queue mechanism accepts the submission but subsequent processing/ack observation requires an explicit `thread/queue/start`, app-server observation, persisted session inspection, or another non-mutating native mechanism, investigate and add only the smallest bounded proof seam. Do not inject a second user message merely to test whether the first one landed.

A proof based only on “command exit 0” is insufficient.

## Concurrency regression

Do not run multiple real external ChatGPT sends for this probe, but keep all deterministic CGL003 concurrency tests green:

- different conversations may proceed independently
- same conversation is cross-process single-flight
- duplicate same relay request sends at most once
- duplicate same Codex return injects at most once
- waiting tasks keep frozen bindings
- no response association by arrival order

## Bounded repair authority

If the real probe exposes a concrete seam bug, you may repair it in this task only when all of these are true:

- the bug is directly required to complete this one-round probe
- the fix preserves CGL000–003 authority boundaries
- focused regression tests are added first or with the fix
- no general scheduler/daemon/autonomous-loop feature is added
- no target/session/runtime fallback is introduced
- no protected/dirty checkout is modified

After a repair, re-run deterministic tests before retrying any external step. Never retry an ambiguous ChatGPT send or Codex injection. A fresh relay request/probe session is required only when prior state is proven not to have crossed the relevant external side-effect boundary.

## Acceptance

PASS requires all of:

1. disposable persisted Codex probe thread created and exact thread ID captured.
2. exact runtime-only ChatGPT target binding created without committing the URL.
3. Local Model RELAY forward gate passes the exact report hash.
4. one real request reaches the exact bound ChatGPT conversation.
5. returned `devexec.codex-prompt` passes exact correlation validation.
6. Local Model RELAY return gate passes the exact prompt hash.
7. native bound runtime fingerprint passes immediately before queue.
8. exactly one queue injection targets the exact original probe thread.
9. exact same-thread acceptance is proven beyond exit code alone.
10. no tracked project file is modified by the probe session itself.
11. all focused tests, `npm run test:devexec`, `npm run build`, and `git diff --check` pass after any bounded repair.
12. any code repair is committed/pushed and remote SHA verified; if no code repair was needed, no empty commit is required.

If any external delivery becomes ambiguous, report the exact terminal state and stop. Do not resend automatically.

## Final report

Include:

- exact branch and HEAD/remote SHA
- whether code changed during CGL004
- native runtime path identity/version (bounded; do not expose secrets)
- probe thread ID or a safe digest if the thread ID should not be surfaced
- Local Model RELAY forward/return result
- exact ChatGPT target conversation ID may be reported in local/operator output but must not be committed
- ChatGPT correlation result
- Codex queue same-thread proof
- deterministic test counts
- `REAL_E2E_PASS`, `REAL_PROBE_BLOCKED`, or fail-closed terminal reason
- next blocker before enabling bounded multi-round looping

Stop after this one real E2E round. Do not enable CGL005/autonomous repetition in this task.
