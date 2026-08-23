# Dev Exec Mission host acceptance packet — 2026-08-23

Status: **implementation-ready / host execution not yet claimed**

This packet turns the current Mission reliability branch into one bounded host-side acceptance command. It does not mark Local Agent, Local Executor, Windows filesystem behavior, child-launch crash timing, or power-loss durability as passed until the command is actually run on the intended checkout/host and its evidence is read back.

## Scope

The packet is intended to run after the Mission lock/recovery/lifetime repair represented by the current branch is checked out from a clean process boundary. It verifies three layers in order:

1. the existing repository Mission reliability bundle, including focused tests, recovery regressions, and the existing real Node child launch/receipt/reconciliation probe;
2. filesystem hard-link/file-identity behavior on the actual host volume used for evidence;
3. new real-process Mission lock checks that prove a live lock owner blocks recovery, forced owner termination leaves recoverable durable evidence, recovery permits a new owner, and a rejected Promise-returning lock callback continues to exclude a competing Node process until its thenable settles.

The real-process lock probe only spawns the current Node executable and disposable child processes it owns. It does not invoke Local Executor, Resolve, network publication, credentials, or unrelated user data.

## Exact host command

From the intended `chatgpt-mcp` checkout:

```powershell
$head = (git rev-parse HEAD).Trim()
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\verify-devexec-mission-host-acceptance.ps1 -ExpectedHead $head
```

A successful run emits `MISSION_HOST_ACCEPTANCE=PASS` and persists a timestamped evidence directory under `%LOCALAPPDATA%\ChatGPTMCPProbe\mission-host-acceptance` by default. Each component output is retained and SHA-256 hashed; `SUMMARY.json` records the checkout HEAD, machine, checks, artifact hashes, and explicit remainder.

A failing component is also persisted before the wrapper fails, so a regression does not disappear behind the first thrown PowerShell error.

## New host probe contracts

`tools/devexec-mission-host-lock-acceptance.mjs` performs two real-process checks:

- **Live owner -> forced death -> recovery:** a child owns the canonical Mission lock, recovery must fail with `MISSION_CONTROL_LOCK_OWNER_ALIVE`, the owned child is force-terminated, the canonical lock must remain as durable evidence, `recoverOrResumeStaleMissionLock()` must recover it, and a new owner must then acquire/release successfully.
- **Returned thenable cross-process exclusion:** `withMissionLock()` must reject the unsupported Promise-returning callback while retaining the canonical lock; an independently spawned Node competitor must see `MISSION_CONTROL_LOCKED`; after the returned thenable settles, its continuation must have observed the canonical lock still present, then the lock must release and a new competitor must acquire successfully.

The existing Mission reliability verifier now syntax-checks the new host-lock probe, but deliberately does not execute its forced-kill scenario as part of the ordinary cloud/repository test bundle.

## Safety and evidence boundaries

A PASS from this packet is host evidence for the bounded checks above only. It is **not** proof of:

- Local Agent / Local Executor end-to-end behavior;
- every Mission child-launch kill timing beyond the process regressions already in the repository;
- OS power-loss or storage-device flush durability;
- unrelated Dev Exec paths;
- `GOAL_PATCH` or `supersede_current_goal`, which remain out of scope until Mission reliability acceptance closes.

Because older already-running Node processes can retain legacy recovery code in memory, host acceptance should start from a clean process boundary or otherwise prove that no older recovery-capable process overlaps the test.

## Cloud validation completed while preparing this packet

- GitHub branch/file/commit readback and compare succeeded.
- The exact new Node host-lock probe was reconstructed from the committed source and `node --check` passed under Node v22.16.0 in the cloud container.
- The cloud container has no `powershell`/`pwsh`, so the PowerShell wrapper and the full repository/host packet were **not executed here**.
- Windows/SHIRO-WS filesystem semantics, forced-kill behavior, Local Agent/Local Executor integration, and power-loss remain host-only until evidence is produced.

## Next acceptance sequence

1. Adversarial-review this packet and the underlying `devexec-mission-lock.mjs` / `devexec-mission-lock-resume.mjs` behavior.
2. Run the exact wrapper on a clean intended checkout and read back `SUMMARY.json` plus all component logs/hashes.
3. If PASS, continue the remaining Local Agent/Local Executor and Mission child-launch kill/restart matrix without broadening into live Goal replacement.
4. Only after Mission reliability acceptance is closed should the project proceed to the typed local Control API/service and then the Operator Console/GUI, per the current requirements.
