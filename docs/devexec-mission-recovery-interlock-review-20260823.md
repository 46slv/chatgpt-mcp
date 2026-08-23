# Dev Exec Mission mixed-recovery interlock review — 2026-08-23

Status: **review finding / production repair required before host acceptance**

Reviewed authority: `automation/devexec-mission-recovery-resume-20260823@e82c0211785e11d0d1dc91baba5d8c3bd4f76ccb`.

## Finding

The new movable recovery-owner protocol correctly blocks a second recovery caller when the PID-bearing owner is the only claim. However, the repository currently exposes two mutating stale-lock recovery surfaces that do not share one arbitration domain:

- `recoverOrResumeStaleMissionLock()` in `tools/devexec-mission-lock-resume.mjs`;
- legacy/conservative `recoverStaleMissionLock()` in `tools/devexec-mission-lock.mjs`.

Two mixed states break the documented exclusive-owner invariant.

### 1. Live movable owner + neutral claim

`claimRecoveryOwnership()` lists PID-bearing owner claims first, but when the neutral `mission-control.lock.stale-<token>.json` path exists it renames that neutral link to a new owner and returns before resolving the already-existing single owner claim. Therefore a live recovery owner can be bypassed if neutral evidence also exists.

This state is not purely synthetic: controlled cleanup can leave both names if restoration finds an existing neutral link, and mixed old/new recovery callers can also create it.

### 2. Legacy recovery + live movable owner

`recoverStaleMissionLock()` does not inspect PID-bearing movable-owner claims. If a live movable owner exists while the neutral name is absent, the legacy function can recreate the neutral hard link, validate the stale token/PID, and unlink the canonical Mission lock underneath the live movable owner.

The current production Mission entry uses the resumable wrapper, so no current production call site for the legacy function was established in this cloud review. Nevertheless the legacy mutator remains exported and covered as an active recovery surface, so the exactly-once argument cannot rely on all callers voluntarily avoiding it.

## Evidence

`tools/devexec-mission-recovery-interlock-probe.mjs` is a diagnostic reproducer on this review branch. It uses the production modules and creates both mixed states. The expected current result is `MIXED_RECOVERY_INTERLOCK_PROBE=REPRODUCED`; it is intentionally **not** added to the normal PASS verifier until the production repair is made.

A source-faithful Node v22.16.0 reconstruction of the same two orderings was executed in the cloud and reproduced both defects: in each case the canonical lock disappeared while a pre-existing live PID-bearing recovery-owner hard link still existed. This proves the arbitration defect in the reviewed semantics, but it is not a substitute for running the repository probe in a real checkout.

No duplicate Local Agent side effect is claimed from this cloud reproduction. The demonstrated defect is narrower but still critical to the reliability proof: exclusive recovery ownership can be invalidated and the canonical lock name can become free while a recorded recovery owner is alive, opening a new Mission-lock acquisition window.

## Required repair contract

Do not fix this with a best-effort pre-check alone. `check owner -> mutate neutral/canonical` would retain a TOCTOU window.

The next production repair should satisfy all of the following:

1. **One arbitration domain.** Every mutating stale-lock recovery entrypoint must participate in the same atomic recovery ownership protocol.
2. **Owner precedence.** An existing PID-bearing owner claim must be resolved before a neutral claim can be consumed. A live owner always fails closed, including when neutral evidence also exists.
3. **No parallel legacy mutator.** Prefer retiring/delegating `recoverStaleMissionLock()` so it cannot independently unlink canonical state. If it remains callable, it must use the same atomic owner protocol rather than a separate pre-check.
4. **Mixed-state regression.** Add desired-behavior tests for live-owner+neutral and legacy-vs-movable-owner states. Both must leave canonical state intact and perform zero Local Agent side effects.
5. **Replacement safety.** Preserve the existing token/PID validation and same-filesystem-object proof immediately before canonical unlink.
6. **Crash resume.** Preserve dead recovery-owner takeover without weakening the live-owner fence.

A practical small-scope path is to make the resumable implementation the sole mutating recovery primitive, migrate the lower-level recovery tests to that primitive, and remove or fail-close the older independent unlink path. Then reorder movable claim handling so an existing owner is processed before any neutral-path ownership transition.

## Host file-identity boundary

A separate host probe was added as `tools/devexec-mission-file-identity-host-probe.mjs`. It creates a canonical file, a true hard link, and a same-content copy, then checks `fs.statSync(..., {bigint:true})`:

- hard-link paths must expose matching `dev + ino`;
- inode identity must be nonzero;
- a copied file must not match the hard-link identity.

The exact probe passed on this cloud Linux Node v22.16.0 environment. It still must run on SHIRO-WS/NTFS.

Primary-source context: Node documents `stats.dev` as the device identifier and `stats.ino` as the filesystem-specific inode number; Microsoft documents Windows file identity using volume serial + file index and explicitly uses FileIndex when recognizing hard links. Those sources support the host-probe design but do not replace direct Node-on-NTFS evidence.

- https://nodejs.org/api/fs.html#statsdev
- https://nodejs.org/api/fs.html#statsino
- https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileinformationbyhandle
- https://learn.microsoft.com/en-us/windows/win32/backup/backing-up-and-restoring-hard-links

## Exact next action

From Worker A base `e82c021...`, reconcile this review branch, repair recovery to one atomic arbitration domain, convert the diagnostic mixed-state cases into passing regressions, and run the existing real-checkout verifier. Only then continue the SHIRO-WS matrix: file-identity probe, recovery-owner kill/resume, live-owner refusal, concurrent recoverer/replacement-before-claim, atomic publication, dispatcher spawn-before-receipt, target/constraint isolation, and STARTING/AMBIGUOUS replay checks.

Keep `GOAL_PATCH / supersede_current_goal` PENDING until this reliability acceptance closes. Do not proceed to Control API/GUI on the basis of cloud-only recovery tests.
