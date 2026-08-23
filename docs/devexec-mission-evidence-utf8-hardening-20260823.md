# Dev Exec Mission host-evidence strict UTF-8 hardening — 2026-08-23

Status: cloud implementation / host acceptance still required

Base reconciled: `automation/devexec-mission-host-bom-review-20260823@8395824ef15ddf6aa7f9e84f60b1d37a1ab7dd45`.

## Why this follows the BOM writer repair

The reviewed Windows PowerShell wrapper now persists component logs and `SUMMARY.json` with explicit UTF-8 without BOM. The Node verifier previously still decoded every persisted byte snapshot with `Buffer.toString("utf8")`, however. That decoder replaces malformed UTF-8 with U+FFFD instead of failing.

For evidence verification, silent replacement is undesirable: the SHA-256 receipt binds the original bytes while marker/JSON interpretation could be performed on a replacement-decoded text representation. A future writer regression could therefore violate the intended canonical text contract without producing a dedicated encoding failure.

## Repair

`tools/devexec-mission-host-evidence-verify.mjs` now treats all persisted host-evidence text as one strict byte contract:

- UTF-8 BOM (`EF BB BF`) is rejected as `MISSION_HOST_EVIDENCE_UTF8_BOM_FORBIDDEN`.
- malformed UTF-8 is rejected through a fatal `TextDecoder` as `MISSION_HOST_EVIDENCE_UTF8_INVALID`.
- valid BOM-free UTF-8 is still hashed and interpreted from the same in-memory byte snapshot.
- the rule applies to `SUMMARY.json`, all five component logs, and persisted verification receipt readback.

`tools/devexec-mission-host-utf8-contract.test.mjs` now adds runtime regressions for BOM-prefixed SUMMARY and malformed component bytes whose recorded SHA is deliberately updated to match. The latter proves that a valid hash alone cannot bypass the encoding contract.

## Validation performed in this cloud run

- GitHub base/head readback and exact branch compare.
- Updated production verifier and test file readback from GitHub.
- Source-faithful Node v22.16.0 semantic probe for the new decoder/read-snapshot logic: valid UTF-8 PASS; BOM rejection PASS; malformed UTF-8 rejection PASS; marker `MISSION_HOST_EVIDENCE_STRICT_UTF8_SEMANTIC_PROBE=PASS`.

Not proven here:

- the full committed Node test bundle from a real repository checkout;
- PowerShell wrapper execution;
- GitHub CI;
- Windows/SHIRO-WS host acceptance;
- Local Agent/Local Executor E2E;
- remaining forced-kill matrix and power-loss durability.

The cloud container still cannot resolve `github.com` directly for a normal checkout, so connector readback and the focused semantic probe must not be represented as a full-checkout PASS.

## Next host/check-out action

On the exact reviewed continuation head, first run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\verify-devexec-mission-constraint-continuation.ps1
```

Then run the pinned SHIRO-WS host packet and verify that both the runtime writer and runtime verifier enforce the same BOM-free strict UTF-8 contract before accepting `SUMMARY.json` / component evidence. Only after the Mission reliability acceptance packet passes should `GOAL_PATCH / supersede_current_goal` or the Control API/service stage expand.
