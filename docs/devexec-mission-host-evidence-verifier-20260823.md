# Dev Exec Mission host evidence verifier — 2026-08-23

Status: **cloud implementation / host execution still required**

## Purpose

The Mission host-acceptance packet already pins the checkout, requires exact component PASS markers, runs filesystem-sensitive probes on the Mission runtime volume, and hashes five component logs into `SUMMARY.json`. The remaining evidence-integrity gap was post-write readback: a later consumer still had to trust the hashes recorded by the producer without a deterministic verifier that reopened the persisted files.

This change adds a separate verifier so `MISSION_HOST_ACCEPTANCE=PASS` is emitted only after the persisted packet has been reopened and checked.

## Verification contract

`tools/devexec-mission-host-evidence-verify.mjs` requires:

- `SUMMARY.json` protocol `devexec.mission-host-acceptance`, schema version 2;
- `summary.head == summary.expected_head == --expected-head`;
- optionally, exact `mission_probe_root == --expected-mission-probe-root` for same-host authoritative verification;
- every required summary check is exactly `PASS`;
- exactly five component artifacts, with no duplicate or unexpected names;
- every artifact resolves inside the evidence run directory;
- every recorded SHA-256 matches the bytes reopened from disk;
- every component contains its exact declared PASS marker.

The summary is parsed and SHA-256 hashed from one in-memory byte snapshot, and each component's hash and PASS marker are likewise checked from one byte snapshot. This prevents the verifier itself from binding a hash to different bytes than those whose structure/marker it actually inspected if another process rewrites a file between separate reads.

The five artifacts remain:

1. `00-repo-preflight.txt` — `MISSION_HOST_PREFLIGHT=PASS`
2. `01-mission-reliability.txt` — `MISSION_RELIABILITY_CHECK=PASS`
3. `02-file-identity.txt` — `MISSION_FILE_IDENTITY_HOST_PROBE=PASS`
4. `03-host-lock-process.txt` — `MISSION_HOST_LOCK_ACCEPTANCE=PASS`
5. `04-repo-postflight.txt` — `MISSION_HOST_PREFLIGHT=PASS`

When `--receipt` is supplied, the verifier writes the complete receipt to a unique temporary file, fsyncs it, then atomically publishes `VERIFICATION.json` with a create-if-absent hard link. It never falls back to replacement semantics. If a competing verifier has already published the receipt, the loser fails with `MISSION_HOST_EVIDENCE_RECEIPT_EXISTS`; an unsupported hard-link boundary fails closed as `MISSION_HOST_EVIDENCE_RECEIPT_ATOMIC_PUBLISH_FAILED`. Temporary cleanup after successful publication is best-effort because the canonical receipt is already complete.

The receipt records the SHA-256 of the exact persisted `SUMMARY.json` plus the independently recomputed component hashes and markers. It intentionally does not self-hash inside its own payload; the wrapper reports the receipt SHA-256 separately.

## Host packet integration

`tools/verify-devexec-mission-host-acceptance.ps1` now performs this order:

`components -> component logs -> SUMMARY.json -> evidence verifier/readback -> VERIFICATION.json -> MISSION_HOST_ACCEPTANCE=PASS`

Therefore a component log modified after its initial hash, a missing PASS marker with a recomputed hash, path substitution outside the run directory, commit identity drift, Mission-root drift, or receipt overwrite attempt all fail before the overall PASS marker.

The operator command remains:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\verify-devexec-mission-host-acceptance.ps1 -ExpectedHead <EXACT_REVIEWED_HEAD>
```

A successful run must now read back both `SUMMARY.json` and `VERIFICATION.json` and preserve their reported SHA-256 values.

## Cloud validation performed

The evidence verifier and focused fixture test were executed under Node v22.16.0 in the cloud reconstruction before GitHub publication. The initial focused suite passed **8/8** and covered valid verification/receipt creation, byte tampering, marker loss with matching hash, artifact path escape, commit pin mismatch, Mission-root mismatch, duplicate/incomplete artifact sets, and immutable pre-existing receipt behavior. `node --check` for the verifier passed.

During self-review, the initial `renameSync()` receipt publication was rejected because POSIX rename can replace a destination created after the pre-check. The committed implementation now uses hard-link create-if-absent publication, and the committed test suite adds a ninth real-process case where two verifier processes compete for one receipt; exactly one must succeed and the loser must fail without replacing the winner. A focused hard-link no-replace semantic probe passed in the cloud (`EEXIST` for the loser and winner bytes unchanged). The later single-byte-snapshot hardening was source-reviewed/read back but the final committed 9-case suite still requires real-checkout execution before being claimed as PASS.

The real PowerShell wrapper, full repository checkout bundle, final committed 9-case suite, Windows/SHIRO-WS filesystem semantics, Local Agent/Local Executor integration, forced-kill timing beyond the existing probes, and power-loss/fsync durability are not claimed by this cloud validation.

## Exact next host acceptance

On a clean SHIRO-WS checkout at the final reviewed branch head, run the host packet with that exact SHA. Read back:

- `SUMMARY.json` and its printed SHA-256;
- `VERIFICATION.json` and its printed SHA-256;
- all five component logs/hashes;
- `mission_probe_root`, confirming it is the actual Mission runtime base.

Only after this packet passes should the reliability slice continue into the Local Agent/Local Executor E2E and the remaining child-launch kill/restart matrix. `GOAL_PATCH / supersede_current_goal` stays pending until the Mission reliability acceptance closes.
