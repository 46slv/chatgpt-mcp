# Mission recovery interlock — narrow repair notes

This note narrows the smallest safe repair for the mixed-recovery defect found during Worker B review of `e82c021...`.

## Do not attempt a partial pre-check

Checking for a PID-bearing owner and then continuing through the older neutral-claim mutator is not sufficient. The owner state can change between the check and canonical unlink. The repair must remove the second mutating arbitration protocol, not merely observe it.

## Small safe contract

1. Make `recoverOrResumeStaleMissionLock()` the sole stale-lock mutation path used by Mission runtime.
2. Retire, delegate, or fail-close the independent `recoverStaleMissionLock()` mutator. Existing tests for inspection/dead-owner semantics should migrate to the resumable path; there must not be two functions that can independently free the same canonical pathname.
3. In `claimRecoveryOwnership()` classify the recovery namespace before changing it:
   - more than one PID-bearing owner: fail closed;
   - PID-bearing owner **and** neutral claim simultaneously: fail closed as `MIXED_CLAIMS` without renaming/removing either name;
   - one owner only: live PID fails closed; dead PID may be atomically taken over using the existing owner-path rename;
   - neutral claim only: treat it as the supported interrupted-neutral recovery case and atomically move it to the caller's owner name;
   - no claims: atomically hard-link canonical to neutral, then claim that neutral path.
4. Preserve token/PID validation, original-owner re-probe, and `dev + ino` same-object proof immediately before canonical unlink.
5. On all validation failures, mutate only names owned by the current recovery attempt. A mixed namespace is evidence of an unresolved inter-protocol/partial-recovery state and should remain intact for diagnosis rather than being auto-normalized.

Fail-closing mixed owner+neutral state is deliberately conservative. Once the legacy mutator is retired, compliant current code should not create that mixed state during a normal recovery. A later migration/cleanup feature may recover it if needed, but it should not be part of the exactly-once critical path until separately proven.

## Required regression conversion

After production repair, convert the review diagnostics into ordinary expected-behavior tests:

- `live owner only` -> `MISSION_CONTROL_LOCK_RECOVERY_ALREADY_CLAIMED`, canonical intact;
- `live owner + neutral` -> deterministic fail-closed mixed-claim result, canonical intact;
- independent legacy recovery call while movable owner exists -> impossible/delegated/fail-closed, canonical intact;
- Mission entry for `live owner + neutral` -> Local Agent callback count **0**;
- existing neutral-only crash resume -> still succeeds;
- dead PID-bearing owner takeover -> still succeeds;
- copied evidence -> still fails file-identity proof.

The review branch intentionally does not modify production recovery semantics because doing only half of this contract would make the safety argument weaker. Worker A should reconcile the complete contract as one coherent repair and run the full Mission reliability verifier afterward.
