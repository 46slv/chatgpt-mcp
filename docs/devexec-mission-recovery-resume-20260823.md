# Dev Exec Mission stale-lock recovery resume — 2026-08-23

Status: **cloud implementation / host acceptance pending**

Base authority: `automation/devexec-mission-stale-recovery-race-review-20260823@2a7eec3d2c36773612f3df7ea252aaacf8543f0a`.

## Problem closed by this slice

The prior recovery protocol safely created a hard-link evidence path before unlinking the stale canonical Mission lock. That prevented a second recoverer from accidentally removing a replacement canonical lock. Its deliberate remaining availability boundary was a process crash after the evidence hard link had been created but before the stale canonical pathname was unlinked: later Mission entry saw the existing recovery claim and stopped forever rather than risk acting on the wrong file.

Content equality alone is not a sufficient resume proof. A replacement file can contain the same JSON fields. Resume therefore needs both exclusive recovery ownership and filesystem-object identity before canonical unlink.

## Movable recovery-owner protocol

`tools/devexec-mission-lock-resume.mjs` adds `recoverOrResumeStaleMissionLock()` as the Mission-entry recovery surface. The existing lower-level `recoverStaleMissionLock()` remains conservative and is not broadened into a generic retry primitive.

For stale lock token `T`:

1. The neutral evidence name remains `mission-control.lock.stale-T.json`.
2. A recoverer atomically renames that neutral hard link to a PID-bearing owner name `mission-control.lock.stale-T.recover-<pid>-<recovery-token>.json`.
3. Only the process holding that movable owner name may approach canonical unlink.
4. If that recovery process dies, a later process verifies the owner PID is dead and atomically renames the exact owner link to its own PID-bearing owner name. Competing successors race on one source pathname; only one rename can succeed.
5. A live recovery-owner PID remains fail-closed with `MISSION_CONTROL_LOCK_RECOVERY_ALREADY_CLAIMED`.
6. Immediately before canonical unlink, the stale lock owner PID is probed again and both the durable record identity and filesystem identity are checked. `fs.statSync(..., {bigint:true})` must report matching `dev + ino` for the owned evidence link and canonical lock. Missing inode identity fails closed.
7. Only after those checks is the stale canonical pathname unlinked. Recovery never removes or renames a later replacement canonical path.
8. On a controlled validation failure, the owner link is released back toward the neutral evidence name. A process crash skips that cleanup, leaving the PID-bearing owner filename as the durable recovery handoff.

This is safety-biased. Multiple owner claims, live owners, invalid records, PID probe failure, unavailable filesystem identity, hard-link failure, or identity mismatch do not authorize canonical mutation.

## Mission-entry wiring

`tools/devexec-mission-entry-runtime.mjs` now uses `recoverOrResumeStaleMissionLock()` only in the pre-Local-Agent Mission entry/restart boundary. Post-start lock failures are still not broadly retried, so recovery cannot replay a Local Agent side effect after its result becomes ambiguous.

`tools/devexec-mission-recovery-claim-entry.test.mjs` now requires an interrupted neutral recovery claim to resume before exactly one Local Agent start, while a live recovery owner still blocks before the callback.

## Regression coverage added

`tools/devexec-mission-lock-resume.test.mjs` covers:

- neutral evidence published before canonical unlink;
- an actual child recovery process exiting after it has atomically taken recovery ownership but before canonical unlink, followed by successful takeover;
- takeover of a dead PID-bearing owner claim;
- refusal to steal a live recovery owner;
- rejection of copied evidence with matching JSON but a different filesystem object.

The repository Mission reliability verifier now syntax-checks the new runtime module and includes the new regression file.

## Validation actually performed in cloud

- GitHub branch/file/commit readback and exact-head checks were performed around writes.
- A source-faithful standalone Node v22.16.0 probe exercised neutral resume, a real recovery child exit before canonical unlink, live-owner refusal, and copied-evidence identity rejection: **4/4 PASS**.
- Direct repository checkout remains unavailable in the cloud container because `github.com` DNS resolution fails. Therefore the repository test bundle, GitHub CI, SHIRO-WS filesystem behavior, forced Windows kill timing, Local Agent/Local Executor integration, and power-loss/directory-metadata durability are **not** claimed.

## Host acceptance

On a real checkout first run:

`powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\verify-devexec-mission-constraint-continuation.ps1`

Then on SHIRO-WS add the recovery-resume cases to the existing Mission reliability matrix:

1. kill a recovery process after owner-claim rename but before canonical unlink; restart must resume and start the Local Agent exactly once;
2. hold a recovery owner live; restart must fail closed before Local Agent side effects;
3. verify NTFS reports usable stable file identity for hard links and that canonical/evidence `dev + ino` match;
4. preserve the existing concurrent recoverer, replacement-before-claim, atomic publication, dead/live lock owner, dispatcher spawn-before-receipt, target/constraint isolation, and STARTING/AMBIGUOUS cases.

Power-loss/directory durability and PID reuse remain separate conservative boundaries. Keep live `GOAL_PATCH / supersede_current_goal` PENDING until this Mission reliability acceptance closes; the next product stage remains typed local Control API/service before GUI.
