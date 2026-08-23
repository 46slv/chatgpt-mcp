# Dev Exec Mission stale-recovery race review — 2026-08-23

Status: cloud review/repair; real checkout and SHIRO-WS acceptance pending

## Finding

Worker A's atomic lock-publication change closes the new-lock partial-write window, but the existing stale-lock recovery still used a `read -> compare -> rename(canonical, quarantine)` sequence.

Two recoverers can inspect and validate the same stale canonical lock. Recoverer 1 can then rename it away and allow a new owner to publish a replacement canonical lock. Recoverer 2, which already passed its token/PID comparison, can subsequently execute its stale `renameSync(canonical, quarantine)` against that replacement. On filesystems where rename replaces an existing destination, that can remove the replacement lock; on other filesystems it can fail after the unsafe decision point. The recovery comment that the canonical lock itself excludes acquirers is therefore not sufficient once another recoverer has freed the name.

## Repair

`recoverStaleMissionLock()` now claims recovery before any canonical removal:

1. Inspect and prove the current owner PID is dead as before.
2. Atomically create the deterministic evidence/claim path `mission-control.lock.stale-<token>.json` as a hard link to the stale canonical record.
3. If the deterministic claim already exists, fail closed with `MISSION_CONTROL_LOCK_RECOVERY_ALREADY_CLAIMED`; do not touch the canonical path.
4. Re-read both claim and canonical and require the same token/PID that was inspected.
5. Unlink the stale canonical name.
6. Retain the hard-linked quarantine as evidence and never touch the canonical path again. A new owner may safely publish after the unlink.

If atomic hard-link claim publication is unavailable, recovery fails closed with `MISSION_CONTROL_LOCK_RECOVERY_ATOMIC_CLAIM_FAILED`; there is no rename fallback. If the canonical source disappeared during claim creation, the path is re-inspected and only a genuinely unlocked result is treated as a benign concurrent completion.

## Regression coverage

`tools/devexec-mission-lock-recovery.test.mjs` now adds:

- a real competing recovery process injected immediately before the first recoverer's canonical removal; the competitor must stop at `MISSION_CONTROL_LOCK_RECOVERY_ALREADY_CLAIMED` and must not publish a replacement;
- a stale-snapshot race where a new live lock is published immediately before recovery claim creation; validation must reject the stale recovery and preserve the replacement lock;
- an interrupted-recovery state where the deterministic claim exists but the stale canonical name was not yet removed; a later automatic recovery must remain fail-closed rather than risk removing a replacement;
- hard-link-unavailable recovery; the stale canonical remains authoritative and no quarantine claim is fabricated.

The existing Mission reliability verifier already runs this recovery test, so the new cases become part of the real-checkout packet without expanding the verifier surface. Its output now explicitly identifies the atomic stale-recovery claim/concurrent-recoverer coverage and the intentionally fail-closed interrupted-claim boundary.

## Validation actually performed

Before committing the production repair, a source-faithful reconstruction of the current lock semantics and the new concurrent-recovery regression was executed with real Node child processes:

- repaired semantics: **2/2 PASS** for concurrent recovery exclusion and interrupted-claim fail-closed behavior;
- prior rename-based semantics under the same regression: **0/2 PASS**, demonstrating that the test catches the reviewed race.

After the GitHub writes, an expanded source-faithful probe of the repaired semantics ran **5/5 PASS**: baseline dead-owner recovery, concurrent-recoverer exclusion, interrupted-claim fail-closed behavior, hard-link-unavailable fail-closed behavior, and replacement-before-claim preservation. Production source and regression files were then read back from the dedicated branch.

Full repository checkout tests, GitHub CI, Windows/SHIRO-WS hard-link semantics, forced OS-kill timing, Local Agent/Local Executor integration, and power-loss durability are not claimed in this cloud review.

## Residual boundary

A crash after the recovery hard-link claim is created but before the stale canonical name is unlinked intentionally leaves both names and blocks automatic recovery with `MISSION_CONTROL_LOCK_RECOVERY_ALREADY_CLAIMED`. This trades availability for replay/ownership safety. Automatic completion of such an interrupted recovery would require a separately proven inode/file-identity reconciliation contract; it is not inferred here.

The same filesystem primitive is now required for both new-lock publication and stale-lock recovery claims, so SHIRO-WS acceptance should verify both paths on the actual Mission filesystem. If hard links are unsupported, keep the named fail-closed result rather than restoring create-then-write or rename-based fallbacks.

## Exact next action

Run the real-checkout reliability packet:

`powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\verify-devexec-mission-constraint-continuation.ps1`

Then on SHIRO-WS add concurrent stale recovery to the existing Mission crash matrix: two recovery attempts against one dead owner, replacement-before-claim, interrupted recovery after claim/before unlink, atomic new-lock publication, dead/live-owner handling, dispatcher spawn-before-receipt, target/constraint isolation, and STARTING/AMBIGUOUS replay refusal. Keep live `GOAL_PATCH / supersede_current_goal` pending until Mission reliability acceptance closes, then continue to the typed local Control API/service before GUI.
