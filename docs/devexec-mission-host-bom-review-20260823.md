# Dev Exec Mission host evidence UTF-8/BOM review — 2026-08-23

Status: **review repair / cloud-visible compatibility defect**

Base reviewed: `automation/devexec-mission-host-evidence-verifier-20260823@85e1deeca9800551587fe25359ef23025dd9815d`.

## Finding

The SHIRO-WS acceptance command intentionally invokes `powershell`, which is Windows PowerShell 5.1 on the current host unless explicitly replaced. In Windows PowerShell 5.1, `Set-Content -Encoding UTF8` writes a UTF-8 BOM. The reviewed host wrapper wrote `SUMMARY.json` with that form, while `devexec-mission-host-evidence-verify.mjs` decodes the file as UTF-8 and passes the resulting string directly to `JSON.parse()`.

Node does not accept U+FEFF at the beginning of a JSON string. Therefore a fully successful host component run could still fail at the persisted evidence readback step solely because the wrapper emitted the Windows PowerShell 5.1 BOM. This is a false-negative host-acceptance defect, not a host-runtime failure.

A focused Node v22.16.0 probe reproduced the premise: BOM-prefixed JSON is rejected by `JSON.parse`, while the same UTF-8 bytes without BOM parse normally (`MISSION_HOST_UTF8_BOM_SEMANTIC_PROBE=PASS`).

## Repair

`tools/verify-devexec-mission-host-acceptance.ps1` now defines one explicit `System.Text.UTF8Encoding($false)` writer and uses it for both component logs and `SUMMARY.json`. This makes evidence bytes independent of the PowerShell edition's `-Encoding UTF8` BOM behavior and keeps the verifier input standard JSON.

A new `tools/devexec-mission-host-utf8-contract.test.mjs` guards the wrapper source contract and records the Node-side BOM rejection premise. The ordinary Mission reliability verifier now includes this test.

## Validation boundary

Actually checked in this cloud run:

- GitHub base/head/readback and diff review.
- Node v22.16.0 semantic probe showing BOM-prefixed JSON parse failure and BOM-free JSON parse success.
- GitHub readback confirms the wrapper uses `UTF8Encoding($false)` / `File.WriteAllText` and no longer uses `Set-Content -Encoding UTF8` for persisted host evidence.

Not run here:

- Windows PowerShell 5.1 execution of the full wrapper.
- Full real-checkout Mission reliability bundle.
- SHIRO-WS host acceptance packet, Local Agent/Local Executor E2E, remaining forced-kill matrix, and power-loss durability.

## Next action

Reconcile this focused branch into the current Mission reliability continuation head, run the real-checkout Mission verifier, then execute the SHIRO-WS host packet pinned to the exact reviewed commit. Confirm `SUMMARY.json` begins with `{` rather than UTF-8 BOM bytes, `VERIFICATION.json` is produced, and both persisted hashes plus all five component logs read back before continuing to Local Agent/Local Executor acceptance.
