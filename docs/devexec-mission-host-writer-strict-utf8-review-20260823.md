# Dev Exec Mission host-evidence writer strict UTF-8 review — 2026-08-23

Status: cloud adversarial review / dedicated branch / host acceptance still required.

## Starting authority and concurrency reconciliation

Worker B initially reviewed `automation/devexec-mission-evidence-utf8-hardening-20260823@71da1dba31513357e3d01e1482a1362d202f094d`. During the review, live Notion and GitHub changed: SHIRO-WS published two test-only repairs and advanced that branch to `550209dec6259a60cab57b0e26b970980554de79` after a 145/145 non-host reliability run. The first B review branch was therefore treated as stale and was not used as the continuation authority.

This reconciled branch starts from exact `550209dec6259a60cab57b0e26b970980554de79` and preserves both concurrent test fixes, including the executable-only `Set-Content -Encoding UTF8` assertion and the Mission lock publication test's retired-recovery-API correction.

## Finding

The reader side was correctly hardened to strict BOM-free UTF-8: `devexec-mission-host-evidence-verify.mjs` uses a fatal `TextDecoder` and rejects a leading UTF-8 BOM. The PowerShell writer, however, still instantiated `.NET UTF8Encoding` with only `encoderShouldEmitUTF8Identifier=false`.

That constructor disables the BOM but does not enable encoding error detection. A .NET string can contain invalid UTF-16 (for example an unpaired surrogate). With replacement fallback, the writer can persist different valid UTF-8 bytes rather than fail. The downstream strict UTF-8 reader then sees only the already-replaced valid bytes and cannot prove that the persisted evidence represents the original captured text.

Microsoft documents the two-argument `UTF8Encoding(Boolean, Boolean)` constructor and recommends setting `throwOnInvalidBytes` to `true` to enable error detection:

- https://learn.microsoft.com/en-us/dotnet/api/system.text.utf8encoding.-ctor
- https://learn.microsoft.com/en-us/dotnet/api/system.text.utf8encoding

PowerShell 5.1 supports `.NET` constructor invocation with `[Type]::new(...)`, so the host wrapper can use the strict two-argument constructor without changing the PowerShell generation boundary:

- https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_object_creation?view=powershell-5.1

## Repair

`tools/verify-devexec-mission-host-acceptance.ps1` now creates the writer as:

```powershell
$script:Utf8NoBom = [System.Text.UTF8Encoding]::new($false, $true)
```

The first argument keeps persisted evidence BOM-free. The second enables fail-closed encoder/decoder fallback behavior instead of silent replacement.

`tools/devexec-mission-host-utf8-contract.test.mjs` preserves the concurrent SHIRO-WS comment-filter repair and additionally:

- requires the strict two-argument constructor in executable wrapper text;
- rejects the previous one-argument/non-throwing constructor forms;
- on Windows, invokes `powershell.exe` with an unpaired surrogate and requires `EncoderFallbackException` before treating the writer contract as satisfied;
- retains positive Japanese/non-ASCII + CRLF acceptance and strict reader rejection of BOM/malformed UTF-8.

## Validation actually performed in this cloud review

- Live GitHub/Notion reconciliation after concurrent Worker/Supervisor activity.
- Reconciled branch created from exact current A head `550209dec6259a60cab57b0e26b970980554de79` rather than overwriting the advanced A branch.
- GitHub write/readback of the strict writer and merged UTF-8 test.
- Current UTF-8 test source passed Node v22.16.0 `node --check` in the cloud container.
- Focused static-regex semantic probe confirmed the strict constructor and writer calls match while comment-only `Set-Content -Encoding UTF8` and old one-argument constructors do not trigger false results.
- Microsoft primary documentation confirms `throwOnInvalidBytes=true` is the error-detecting constructor contract and PowerShell 5.1 supports `[Type]::new(...)`.

Not proven here:

- the Windows-only unpaired-surrogate regression itself;
- the complete committed Mission reliability test bundle on this reconciled head;
- the pinned SHIRO-WS host acceptance packet and persisted `SUMMARY.json` / `VERIFICATION.json` readback;
- Local Agent / Local Executor E2E;
- remaining forced-kill timing matrix;
- power-loss/fsync durability.

## Exact next action

On a real/SHIRO-WS checkout at the exact reconciled head, run the ordinary Mission reliability verifier first. The Windows-only strict-writer regression must execute rather than skip and the full suite must remain green. Then run `verify-devexec-mission-host-acceptance.ps1` pinned to that exact head and read back `SUMMARY.json`, `VERIFICATION.json`, both SHA-256 values, all five component logs/hashes, and `mission_probe_root`.

Only after the Mission reliability/host evidence packet passes should work expand to Local Agent/Local Executor E2E and the remaining kill/restart acceptance. `GOAL_PATCH / supersede_current_goal` and Control API/GUI expansion remain gated behind reliability closure.
