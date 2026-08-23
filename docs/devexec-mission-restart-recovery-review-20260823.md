# Dev Exec Mission restart/recovery review — 2026-08-23

Status: **Worker B review / dedicated non-main branch**

Base reviewed: `automation/devexec-mission-preflight-acceptance-20260823@a493041d7aa0fec6a6cd944d5e4547a50a03fc5d`

## Findings

### 1. The new crash regression did not cross the production dispatcher spawn boundary

The existing `after_child_side_effect` case correctly proved that a durable `LAUNCHING` record blocks replay after a process exit, but its child side effect was created by a separate manual `spawnSync()` after `beginMissionChildLaunch()`. It did not exercise the actual `dispatchMissionChildLaunch()` ordering around:

`PENDING -> LAUNCHING -> spawn -> spawn event -> durable receipt`.

The review branch adds a fault-injected real-dispatcher case. It uses the production dispatcher with a real Node child and terminates the parent from the child `spawn` event before the dispatcher's own spawn waiter can persist a receipt. After restart, the durable launch must still be `LAUNCHING`, the child marker must exist exactly once, and a second dispatcher call must fail before invoking `spawn_impl`.

This is still a process-exit simulation, not an OS forced-kill or power-loss proof.

### 2. A crashed Mission lock was permanently unrecoverable

The production lock uses an exclusive `mission-control.lock` file and intentionally rejects all existing locks. The new Worker A cross-process test correctly demonstrated that a crashed lock holder leaves the file behind and all later acquisition fails closed.

That default behavior prevents unsafe blind takeover, but it also means a single process crash can permanently block `openMissionControl()` and therefore block restart/self-launch before later replay guards can even inspect Mission state.

This review adds a conservative recovery surface without changing normal lock acquisition:

- new locks durably record `pid` in addition to token/owner/time;
- `inspectMissionLock()` classifies `UNLOCKED`, `HELD`, `STALE`, `UNKNOWN_OWNER`, `INVALID`, or `PROBE_FAILED`;
- only `STALE` (recorded PID is definitively absent) is recoverable;
- `recoverStaleMissionLock()` re-reads and compares the exact token/PID before mutation;
- recovery atomically renames the stale lock to an evidence-preserving quarantine file instead of deleting it;
- a live owner, legacy/no-PID lock, invalid record, or failed PID probe remains fail-closed;
- normal `acquireMissionLock()` still never auto-recovers or steals a lock.

A separate real-process regression covers dead-owner quarantine + later reacquire, live-owner refusal, and legacy/no-PID fail-closed behavior.

### 3. Recovery is now wired only at the pre-side-effect Mission entry boundary

Leaving the primitive completely unwired would still make unattended restart impossible. Wiring it inside generic `acquireMissionLock()` or retrying the whole Local Agent start after an arbitrary lock failure would be unsafe: a lock failure can occur after the Local Agent side effect, and a broad retry could duplicate that side effect.

`startMissionLocalAgent()` therefore performs one narrow entry preflight **before any Local Agent start callback can run**:

1. resolve the Mission root;
2. inspect the current lock;
3. if and only if it is `STALE`, quarantine that exact dead-owner lock;
4. if it is `HELD`, leave it untouched and allow normal `MISSION_CONTROL_LOCKED` behavior;
5. if ownership is `UNKNOWN_OWNER`, `INVALID`, or `PROBE_FAILED`, fail with `MISSION_CONTROL_LOCK_RECOVERY_UNSAFE` before invoking Local Agent;
6. continue through normal Mission state/admission/launch guards.

No later lock failure is auto-recovered or retried inside the same `startMissionLocalAgent()` call. A crash after `STARTING` or another side-effect fence therefore remains protected by the existing `STARTING`/`AMBIGUOUS` replay guards rather than causing a second Local Agent start.

Focused entry-runtime regressions were added for verified dead-owner recovery, live-owner refusal, and legacy/no-PID refusal. The successful result also returns `lock_recovery` evidence for handoff/diagnostics.

## Recovery safety boundary

PID liveness is used only to authorize availability recovery. A reused PID can conservatively make a stale lock look `HELD` and delay recovery, but it does not authorize stealing a live lock. Locks without a durable PID are deliberately not migrated or guessed.

A crash in the narrow interval before a valid owner record is durably written can leave an invalid/unknown lock; that remains fail-closed and is **not** silently deleted by this change. Power-loss/fsync and stronger process-instance identity remain separate reliability work.

## Validation performed in this cloud run

Confirmed through GitHub readback/compare:

- Worker A base remained the reviewed 8-ahead branch before B branching.
- Review branch changes are isolated from A/main.
- New lock/recovery source, Mission-entry integration, regressions, and actual-dispatcher crash regression were written and read back.

Executed locally against a source-faithful reconstruction of the new lock module + recovery test:

- `node --check` module: PASS
- `node --check` recovery test: PASS
- recovery regression: **3/3 PASS**
  - dead owner -> explicit quarantine -> later acquire
  - live owner -> recovery refused
  - legacy/no-PID owner -> recovery refused

Not claimed in this cloud run:

- full repository checkout verifier (cloud DNS cannot resolve `github.com`);
- GitHub CI;
- execution of the new Mission-entry integration tests against the complete repository module graph;
- execution of the new actual-dispatcher crash test against the complete repository module graph;
- Windows/SHIRO-WS behavior;
- Local Agent/Local Executor integration;
- forced OS-kill timing;
- power-loss/fsync durability.

## Exact continuation

Worker A should reconcile this review branch and first run `tools/verify-devexec-mission-constraint-continuation.ps1` in a real checkout. On SHIRO-WS, add these acceptance cases before broadening scope:

1. kill a process while it holds `mission-control.lock`; a fresh Mission entry must classify the recorded dead PID as stale, quarantine that exact token/PID, reopen Mission state, and continue without deleting evidence;
2. hold the lock from a still-live process; a second Mission entry must not recover it and must not invoke Local Agent;
3. kill the parent after the production dispatcher has emitted a successful child spawn but before receipt persistence; restart must not spawn a second child;
4. preserve the existing target/constraint isolation and `STARTING`/`AMBIGUOUS` crash matrix.

Keep live `GOAL_PATCH / supersede_current_goal` pending until this reliability boundary is closed. Afterward, continue the staged typed Control API/service work before GUI.
