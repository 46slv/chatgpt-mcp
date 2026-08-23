# Dev Exec Mission recovery arbitration — 2026-08-23

Status: implementation checkpoint on dedicated automation branch. This does not claim Windows/SHIRO-WS acceptance, Local Agent/Local Executor integration acceptance, or power-loss durability.

## Problem closed in this checkpoint

Mission stale-lock recovery had two independently mutating protocols:

1. `recoverOrResumeStaleMissionLock()` with movable PID-bearing recovery-owner claims.
2. exported `recoverStaleMissionLock()` with a separate neutral hard-link recovery path.

That split allowed a live movable recovery owner to be bypassed. A namespace containing both a live owner and neutral evidence could consume the neutral path, and the legacy mutator could remove the canonical stale lock without recognizing the movable owner. The reviewed Mission-entry diagnostic showed that this could reach the Local Agent start boundary.

## Repair

`recoverOrResumeStaleMissionLock()` is now the sole mutating recovery arbitration surface (`movable-owner-v2`). Its claim loop classifies the complete recovery namespace before mutation:

- more than one owner claim -> fail closed;
- one owner plus neutral evidence -> `MISSION_CONTROL_LOCK_RECOVERY_MIXED_CLAIMS`, no mutation;
- one live owner -> `MISSION_CONTROL_LOCK_RECOVERY_ALREADY_CLAIMED`;
- one dead owner -> atomic owner-claim takeover;
- neutral evidence only -> atomic transition to one owner claim;
- no recovery evidence -> publish neutral hard-link evidence, then reclassify before ownership transition.

Immediately before canonical unlink, the implementation again verifies token/PID, dead original owner, filesystem identity (`dev + ino`), and exclusive recovery namespace ownership. Any foreign owner or reappearing neutral evidence preserves the canonical lock and fails closed.

`recoverStaleMissionLock()` remains exported only as a compatibility surface but is now non-mutating. Any locked state returns `MISSION_CONTROL_LOCK_RECOVERY_LEGACY_MUTATOR_RETIRED` and points callers to `recoverOrResumeStaleMissionLock()`.

## Regression changes

- `devexec-mission-lock-recovery.test.mjs` now routes real recovery behavior through the resumable arbiter and proves the legacy export cannot mutate a stale canonical lock.
- `devexec-mission-lock-resume.test.mjs` covers neutral resume, real recoverer crash/resume, live-owner refusal, owner+neutral mixed-state refusal with all names intact, copied-evidence identity rejection, and multiple-owner refusal.
- `devexec-mission-recovery-api-boundary.test.mjs` scans production `tools/*.mjs` and fails if a runtime module starts using the retired `recoverStaleMissionLock` mutation surface again. The low-level regression probe is the only intentional non-test caller allowed by this check.
- The previous interlock diagnostics are now PASS regressions:
  - `devexec-mission-recovery-interlock-probe.mjs`
  - `devexec-mission-recovery-entry-interlock-probe.mjs`
- Mission entry expects `movable-owner-v2`.
- `verify-devexec-mission-constraint-continuation.ps1` runs the API-boundary test and both interlock regressions in addition to the existing Mission reliability bundle and real Node child launch probe.

## Validation actually performed in cloud

- GitHub writes/readback and branch compare were successful.
- A source-faithful standalone Node semantic probe exercised baseline stale recovery, live owner + neutral mixed state, live-owner exclusion, and copied-evidence rejection: `MISSION_RECOVERY_ARBITRATION_SEMANTIC_PROBE=PASS`.
- Direct container checkout/run of repository tests remains unavailable because the container cannot resolve `raw.githubusercontent.com` / `github.com`.
- GitHub combined status list at the implementation checkpoint was empty; no CI PASS is claimed.

## Remaining acceptance

On a real checkout, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\verify-devexec-mission-constraint-continuation.ps1
```

Then on SHIRO-WS verify at minimum:

1. live recovery owner + neutral evidence blocks before Local Agent side effects and leaves canonical/claims intact;
2. legacy recovery entry cannot mutate a stale lock and the API-boundary test finds no production caller;
3. dead recovery-owner takeover/resume remains exactly-once;
4. NTFS hard-link file identity probe passes on the actual Mission volume;
5. concurrent recovery, replacement-before-claim, atomic lock publication, `STARTING/AMBIGUOUS`, spawn-before-receipt, target/constraint isolation, and kill/restart matrix remain passing.

### Deployment compatibility caveat

The source-level single-mutator invariant applies once processes are running this code. An already-running process that loaded an older implementation could still contain the retired legacy mutator in memory. Do not treat a rolling overlap between old and new recovery code as accepted by this cloud checkpoint. Host acceptance should start the new runtime from a clean process boundary (or otherwise prove no older recovery-capable process remains) before exercising the recovery matrix.

Keep `GOAL_PATCH / supersede_current_goal` pending until this reliability acceptance closes. The next product stage remains typed local Control API/service before GUI.