# Dev Exec Mission host acceptance packet — 2026-08-23

Status: **implementation-ready / host execution not yet claimed**

This packet turns the current Mission reliability branch into one bounded host-side acceptance command. It does not mark Local Agent, Local Executor, Windows filesystem behavior, child-launch crash timing, or power-loss durability as passed until the command is actually run on the intended checkout/host and its evidence is read back.

## Scope

The packet is intended to run after the Mission lock/recovery/lifetime repair represented by the current branch is checked out from a clean process boundary. It verifies five evidence layers in order:

1. **source checkout preflight**: the requested directory is the actual Git toplevel, the required `ExpectedHead` matches, and tracked/untracked worktree state is clean;
2. the existing repository Mission reliability bundle, including focused tests, recovery regressions, and the existing real Node child launch/receipt/reconciliation probe;
3. filesystem hard-link/file-identity behavior on the **actual Mission-state filesystem** derived from the same `LOCALAPPDATA` base used by `devexec-goal.mjs`;
4. real-process Mission lock checks on that same Mission-state filesystem: live owner refusal, forced owner death/recovery, and returned-thenable cross-process exclusion;
5. **source checkout postflight**: the reviewed HEAD and clean worktree state are rechecked after all components so a PASS cannot be attributed to a commit if the test run modified repository source/state.

The real-process lock probe only spawns the current Node executable and disposable child processes it owns. It does not invoke Local Executor, Resolve, network publication, credentials, or unrelated user data.

## Evidence-integrity invariant

Host evidence must be attributable to an explicitly reviewed Git commit. `HEAD` alone is insufficient because local tracked edits or untracked replacement modules can change executed source without changing the commit SHA. The host wrapper therefore requires `-ExpectedHead`, and `tools/devexec-mission-host-preflight.mjs` fails closed on:

- dirty tracked or staged files;
- untracked files anywhere in the repository;
- expected-HEAD mismatch;
- invocation from a nested path that is not the Git toplevel;
- Git inspection failure.

The same guard is run before and after the acceptance components. Evidence directories use a millisecond timestamp plus random suffix so repeated or concurrent runs do not silently reuse a prior run directory. Every component must both exit successfully and emit its exact declared PASS marker; exit code 0 alone is not enough for the summary to claim PASS.

Filesystem-sensitive evidence is intentionally decoupled from `EvidenceRoot`. The operator may store logs on another volume, but the hard-link identity and real-process lock probes remain bound to the Mission runtime base (`LOCALAPPDATA`, with the same user-home fallback semantics as `devexec-goal.mjs`). `SUMMARY.json` records that `mission_probe_root` explicitly.

## Exact host command

From the intended `chatgpt-mcp` checkout, use the exact reviewed commit SHA supplied by the worker handoff:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\verify-devexec-mission-host-acceptance.ps1 -ExpectedHead <REVIEWED_COMMIT_SHA>
```

The wrapper intentionally does not provide an authoritative acceptance mode without a pinned commit. If exploratory testing of another checkout is useful, obtain/review that commit first and pass its exact SHA rather than self-blessing an arbitrary current HEAD.

A successful run emits `MISSION_HOST_ACCEPTANCE=PASS` and persists a unique evidence directory under `%LOCALAPPDATA%\ChatGPTMCPProbe\mission-host-acceptance` by default. Component output is retained and SHA-256 hashed; `SUMMARY.json` schema v2 records checkout HEAD, machine, Mission probe root, checks, artifact hashes, and explicit remainder.

A failing component or missing PASS marker is persisted before the wrapper fails, so a regression does not disappear behind the first thrown PowerShell error.

## Host probe contracts

`tools/devexec-mission-host-lock-acceptance.mjs` performs two real-process checks under `DEVEXEC_MISSION_HOST_PROBE_ROOT`, which the authoritative wrapper pins to the Mission base:

- **Live owner -> forced death -> recovery:** a child owns the canonical Mission lock, recovery must fail with `MISSION_CONTROL_LOCK_OWNER_ALIVE`, the owned child is force-terminated, the canonical lock must remain as durable evidence, `recoverOrResumeStaleMissionLock()` must recover it, and a new owner must then acquire/release successfully.
- **Returned thenable cross-process exclusion:** `withMissionLock()` must reject the unsupported Promise-returning callback while retaining the canonical lock; an independently spawned Node competitor must see `MISSION_CONTROL_LOCKED`; after the returned thenable settles, its continuation must have observed the canonical lock still present, then the lock must release and a new competitor must acquire successfully.

`tools/devexec-mission-file-identity-host-probe.mjs` similarly runs under `DEVEXEC_FILE_IDENTITY_PROBE_ROOT=$missionBase`; a custom evidence directory cannot redirect this filesystem proof to a different volume.

The ordinary Mission reliability verifier syntax-checks the host-lock/preflight modules and runs the host-preflight plus host-wrapper contract tests, but deliberately does not execute the forced-kill host-lock scenario as part of the normal cloud/repository test bundle.

## Safety and evidence boundaries

A PASS from this packet is host evidence for the bounded checks above only. It is **not** proof of:

- Local Agent / Local Executor end-to-end behavior;
- every Mission child-launch kill timing beyond the process regressions already in the repository;
- OS power-loss or storage-device flush durability;
- unrelated Dev Exec paths;
- `GOAL_PATCH` or `supersede_current_goal`, which remain out of scope until Mission reliability acceptance closes.

Because older already-running Node processes can retain legacy recovery code in memory, host acceptance should start from a clean process boundary or otherwise prove that no older recovery-capable process overlaps the test.

## Cloud validation completed while preparing/reviewing this packet

- GitHub branch/file/commit readback and compare succeeded.
- The checkout-preflight contract has focused clean/dirty/untracked/wrong-HEAD/nested-root regression coverage using disposable Git repositories.
- The focused preflight suite ran source-faithfully under Node v22.16.0 + Git 2.47.3 with **5/5 PASS**; a separate CLI probe confirmed dirty tracked state exits nonzero with `MISSION_HOST_PREFLIGHT_DIRTY_WORKTREE`.
- Static wrapper-contract coverage guards pinned HEAD, pre/postflight, unique evidence directory identity, component PASS markers, and binding of filesystem-sensitive probes to the Mission base.
- The cloud container has no `powershell`/`pwsh`, so the PowerShell wrapper and full Windows host packet are **not executed here**.
- Windows/SHIRO-WS filesystem semantics, forced-kill behavior, Local Agent/Local Executor integration, and power-loss remain host-only until evidence is produced.

## Next acceptance sequence

1. Run the ordinary Mission reliability verifier from a clean real checkout and confirm the new host-preflight/wrapper-contract tests pass.
2. Run the host wrapper pinned to the exact reviewed branch HEAD and read back `SUMMARY.json` plus all five component logs/hashes. Confirm `mission_probe_root` is the intended Mission runtime base even if evidence is redirected elsewhere.
3. If PASS, continue the remaining Local Agent/Local Executor and Mission child-launch kill/restart matrix without broadening into live Goal replacement.
4. Only after Mission reliability acceptance is closed should the project proceed to the typed local Control API/service and then the Operator Console/GUI, per the current requirements.
