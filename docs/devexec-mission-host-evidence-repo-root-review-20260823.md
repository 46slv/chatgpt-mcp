# Dev Exec Mission host evidence repository-root binding — 2026-08-23

Status: cloud adversarial review / reliability hardening.

## Finding

The persisted Mission host evidence verifier pinned the reviewed commit SHA and Mission filesystem root, but did not independently pin `SUMMARY.json.repo` to the checkout that invoked the host packet. The wrapper writes `repo = $repoRoot`, yet a modified SUMMARY could change that metadata and still satisfy the existing commit/hash/marker checks.

For an authoritative host packet, commit identity and checkout identity are separate evidence fields. The verifier should bind both instead of relying on the producer to preserve `repo` metadata correctly.

## Repair

`tools/devexec-mission-host-evidence-verify.mjs` now accepts `expectedRepoRoot`. When supplied it:

1. requires `summary.repo`;
2. canonicalizes both recorded and caller-pinned repository roots through real filesystem paths;
3. rejects mismatch with `MISSION_HOST_EVIDENCE_REPO_ROOT_MISMATCH`;
4. records the verified `repo_root` in `VERIFICATION.json`.

`tools/verify-devexec-mission-host-acceptance.ps1` now passes `--expected-repo-root $repoRoot`, so the authoritative SHIRO-WS packet always enables this check. The ordinary JavaScript API keeps the option explicit so focused non-host fixtures that are not claiming repository attribution do not silently acquire a fake checkout requirement.

Regression coverage was added to `devexec-mission-host-evidence-verify.test.mjs`, including a wrong-repository rejection and receipt binding, and the wrapper contract now requires the repo-root pin.

## Validation performed

- GitHub source/commit readback for verifier, wrapper, and tests.
- Source-faithful Node probe against real temporary filesystem roots: matching repo root PASS; mismatched repo root rejected with `MISSION_HOST_EVIDENCE_REPO_ROOT_MISMATCH`; missing recorded repo rejected when the pin is requested. Marker: `MISSION_HOST_EVIDENCE_REPO_ROOT_PROBE=PASS`.

The final committed full evidence-verifier test bundle, PowerShell wrapper, GitHub CI, and SHIRO-WS host packet are still not claimed as executed in this cloud runtime.

## Next acceptance

Run the ordinary Mission reliability verifier on the reconciled exact review head, then the pinned SHIRO-WS host packet. The resulting `VERIFICATION.json` must contain the canonical reviewed `repo_root` in addition to the already-pinned `expected_head` and `mission_probe_root`. Read back SUMMARY, VERIFICATION, hashes, all five component logs/hashes, and the Mission probe root before continuing Local Agent/Local Executor and remaining forced-kill acceptance.
