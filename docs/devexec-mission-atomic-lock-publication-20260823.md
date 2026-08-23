# Dev Exec Mission lock atomic publication — 2026-08-23

Status: cloud implementation / host acceptance pending

## Problem closed

The restart-recovery work at `automation/devexec-mission-restart-recovery-review-20260823@2bf60438c3a95f1f6b1c23435165d5b4e6a440d9` made a complete stale lock recoverable, but the lock acquisition path still exposed the canonical `mission-control.lock` with `open(..., "wx")` before its JSON owner record was completely written and fsynced.

A process crash in that narrow window could therefore leave an empty or partial canonical lock. `inspectMissionLock()` would correctly classify it as `INVALID`, but no PID/token proof would exist to recover it automatically, so unattended restart could remain permanently blocked.

## Repair

`acquireMissionLock()` now publishes a lock in two phases:

1. Write the complete owner record to a unique non-canonical staging file in the Mission directory.
2. `fsync` and close that staging file.
3. Atomically create the canonical lock as a hard-link to the complete staging inode with `fs.linkSync()`.
4. Remove the staging alias best-effort after canonical publication.

The canonical path is therefore never visible with a partially written new lock during an ordinary process crash.

Contention stays fail-closed. A failed hard-link is treated as `MISSION_CONTROL_LOCKED` when the canonical path exists. A filesystem that cannot provide this atomic publication primitive fails with `MISSION_CONTROL_LOCK_ATOMIC_PUBLISH_FAILED`; there is intentionally no weaker create-then-write fallback.

After publication, staging cleanup must not make acquisition report failure: if the process crashes or cleanup fails after `linkSync()`, the canonical record is already complete and authoritative. The leftover `*.claim-*.tmp` alias is non-canonical and does not block acquisition/recovery decisions.

`release()` also verifies both token and PID before deleting the canonical lock.

## Regression coverage

New `tools/devexec-mission-lock-publication.test.mjs` exercises process and publication boundaries:

- child exits immediately before canonical hard-link publication: canonical lock is absent/UNLOCKED and a later acquisition succeeds;
- child exits immediately after publication but before staging cleanup: canonical lock is complete, stale, and recoverable by the existing quarantine path;
- hard-link publication reports unsupported/EPERM: acquisition fails closed with `MISSION_CONTROL_LOCK_ATOMIC_PUBLISH_FAILED`, with no canonical or staging residue from that attempt;
- normal acquisition removes the staging alias.

The repository reliability verifier now includes this test.

## Validation actually performed in cloud

Against the fetched current Mission lock source and existing lock regression semantics:

- `node --check` for the modified lock module: PASS;
- publication regressions plus existing lock regressions: **8/8 PASS**;
- GitHub branch/file/commit readback and exact-base comparison: PASS.

This does **not** claim the full repository checkout suite, GitHub CI, Windows/SHIRO-WS filesystem behavior, forced OS-kill timing, Local Agent/Local Executor integration, or power-loss durability.

## Remaining acceptance boundary

On a real checkout, run:

`powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\verify-devexec-mission-constraint-continuation.ps1`

Then on SHIRO-WS prove the hard-link publication path on the actual Mission filesystem together with the existing restart matrix: dead-holder recovery, live-holder refusal, dispatcher spawn-before-receipt crash with no duplicate child, target/constraint isolation, and STARTING/AMBIGUOUS replay refusal.

Power-loss and directory-metadata durability remain separate. If the target filesystem does not support the required atomic hard-link publication, keep the named fail-closed result rather than silently falling back to the old partial-canonical window.

Keep live `GOAL_PATCH / supersede_current_goal` pending until Mission continuation reliability acceptance closes. The next staged product work remains the typed local Control API/service before GUI.
