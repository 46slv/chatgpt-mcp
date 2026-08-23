# Mission recovery interlock — entry impact

The mixed-claim defect is not limited to an internal recovery bookkeeping invariant.

`startMissionLocalAgent()` calls `prepareMissionEntryLock()` before Local Agent side effects. For a stale Mission lock, that preparation delegates to `recoverOrResumeStaleMissionLock()`. Under the reviewed ordering, a namespace containing both a live PID-bearing recovery owner and a neutral hard-link can consume the neutral link as a second owner, remove the canonical stale lock, return recovery success, and then allow `startMissionLocalAgent()` to invoke the Local Agent callback.

A source-faithful Node v22.16.0 semantic reconstruction was executed in cloud with that ordering and observed:

- canonical stale lock removed;
- the pre-existing live recovery-owner hard link still present;
- Local Agent callback count = **1**.

Result marker: `MISSION_RECOVERY_ENTRY_INTERLOCK_SEMANTIC_PROBE=REPRODUCED`.

This is still not a real-checkout execution of `tools/devexec-mission-recovery-entry-interlock-probe.mjs`, so no repository-test or Windows result is claimed. It does, however, raise the repair above a cosmetic protocol cleanup: the live-owner exclusion that is intended to fence Local Agent start can be bypassed by the mixed claim state.

After repair, the repository entry probe should be converted to a normal regression and require callback count **0**, canonical lock intact, and a deterministic fail-closed recovery error whenever a live recovery owner exists, regardless of whether neutral evidence is also present.
