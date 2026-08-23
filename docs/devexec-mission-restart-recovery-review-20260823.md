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

This review adds an **explicit, conservative recovery primitive** rather than changing default acquisition behavior:

- new locks durably record `pid` in addition to token/owner/time;
- `inspectMissionLock()` classifies `UNLOCKED`, `HELD`, `STALE`, `UNKNOWN_OWNER`, `INVALID`, or `PROBE_FAILED`;
- only `STALE` (recorded PID is definitively absent) is recoverable;
- `recoverStaleMissionLock()` re-reads and compares the exact token/PID before mutation;
- recovery atomically renames the stale lock to an evidence-preserving quarantine file instead of deleting it;
- a live owner, legacy/no-PID lock, invalid record, or failed PID probe remains fail-closed;
- normal `acquireMissionLock()` still never auto-recovers or steals a lock.

A separate real-process regression covers dead-owner quarantine + later reacquire, live-owner refusal, and legacy/no-PID fail-closed behavior.

## Why recovery is not wired automatically here

The correct recovery call site is a restart/heartbeat decision boundary, not generic lock acquisition. Automatic takeover inside `acquireMissionLock()` would erase the distinction between normal contention and a verified dead owner and would make every caller capable of changing recovery policy.

The next integration should therefore:

1. encounter `MISSION_CONTROL_LOCKED` during an explicit restart/recovery path;
2. inspect the lock;
3. quarantine it only when classification is `STALE`;
4. reopen Mission state and launch/admission journals from disk;
5. preserve existing fail-closed behavior for `LAUNCHING`, `AMBIGUOUS`, `STARTING`, and other uncertain side-effect states;
6. continue only through the existing typed replay/continuation guards.

`UNKNOWN_OWNER`, `INVALID`, `PROBE_FAILED`, and a live owner remain human/diagnostic boundaries until a stronger ownership proof exists.

## Validation performed in this cloud run

Confirmed through GitHub readback/compare:

- Worker A base remained the reviewed 8-ahead branch before B branching.
- Review branch changes are isolated from A/main.
- New lock/recovery source and actual-dispatcher crash regression were written and read back.

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
- execution of the new actual-dispatcher crash test against the complete repository module graph;
- Windows/SHIRO-WS behavior;
- Local Agent/Local Executor integration;
- forced OS-kill timing;
- power-loss/fsync durability.

## Exact continuation

Worker A should reconcile this small review branch, run `tools/verify-devexec-mission-constraint-continuation.ps1` in a real checkout, and then wire explicit stale-lock recovery only into the restart/heartbeat recovery path. On SHIRO-WS, add two acceptance cases before broadening scope:

1. kill a process while it holds `mission-control.lock`; restart must classify the recorded dead PID as stale, quarantine that exact token/PID, reopen Mission state, and continue without deleting evidence;
2. kill the parent after the production dispatcher has emitted a successful child spawn but before receipt persistence; restart must not spawn a second child.

Keep live `GOAL_PATCH / supersede_current_goal` pending until this reliability boundary is closed. Afterward, continue the staged typed Control API/service work before GUI.
