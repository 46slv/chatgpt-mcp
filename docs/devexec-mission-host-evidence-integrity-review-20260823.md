# Dev Exec Mission host evidence-integrity review — 2026-08-23

Status: **review repair implemented / Windows host acceptance not yet claimed**

Reviewed base: `automation/devexec-mission-host-acceptance-20260823@53761c7f04e05c25f7291ad40e03831a232bb55e`

Review branch: `automation/devexec-mission-host-evidence-integrity-review-20260823`

## Findings

### 1. HEAD-only attribution could false-PASS

The Worker A host packet pinned `git rev-parse HEAD`, but did not prove that the checkout executing the packet matched that commit's content. A tracked local edit, staged edit, or untracked replacement module can change executed source without changing `HEAD`. In that state the old packet could still emit `MISSION_HOST_ACCEPTANCE=PASS` and label the evidence with the unchanged commit SHA.

The original evidence directory was also named at one-second resolution and created with `-Force`, so concurrent/repeated invocations could reuse the same directory rather than establish a unique evidence root.

### 2. Exit code alone was weaker than the component evidence contract

The wrapper treated native exit code 0 as sufficient and then marked every summary check PASS. The current component scripts already expose explicit PASS markers. Requiring those markers avoids silently accepting a future no-op/early-return path that exits 0 without completing its declared evidence contract.

### 3. Filesystem-sensitive probes could run on the wrong volume

The original wrapper set `DEVEXEC_FILE_IDENTITY_PROBE_ROOT` to the evidence run directory, and the host-lock probe used `os.tmpdir()`. If an operator redirected `EvidenceRoot` or TEMP to another drive/filesystem, the packet could prove hard-link/file-identity and lock/recovery behavior somewhere other than the filesystem that actually stores Mission state. That is insufficient because the recovery implementation depends on hard-link publication and `dev + ino` identity semantics.

`devexec-goal.mjs` stores Mission state under its `BASE`, which is `LOCALAPPDATA` with the user-home `AppData/Local` fallback. Host filesystem evidence must therefore be bound to the same base, regardless of where logs are stored.

These are evidence-integrity defects rather than defects in the Mission lock algorithm itself. They matter because SHIRO-WS acceptance is intended to be the host authority for closing the current reliability slice.

## Repair

Added `tools/devexec-mission-host-preflight.mjs` as a cross-platform Git checkout guard. It requires:

- the requested repository directory to equal Git's actual toplevel;
- expected HEAD equality when requested by the caller;
- no tracked, staged, or untracked worktree changes;
- successful Git inspection.

The authoritative host wrapper itself now requires a nonblank `-ExpectedHead`; it no longer offers an unpinned PASS mode.

The host wrapper now:

1. creates a unique millisecond-plus-random evidence directory without `-Force` reuse;
2. persists a `00-repo-preflight` result before running the acceptance components;
3. requires each component's explicit PASS marker as well as exit code 0;
4. derives `missionBase` using the same `LOCALAPPDATA` / user-home fallback contract as `devexec-goal.mjs`;
5. runs both file-identity and real-process Mission-lock probes under that Mission filesystem, not under `EvidenceRoot` or arbitrary TEMP;
6. persists a `04-repo-postflight` check pinned to the reviewed HEAD;
7. emits `SUMMARY.json` schema v2 only after both checkout guards and all component marker checks pass, recording `mission_probe_root`.

The ordinary Mission reliability verifier now syntax-checks the preflight module and runs both the preflight behavior tests and a static host-wrapper contract test.

## Regression coverage

`tools/devexec-mission-host-preflight.test.mjs` covers:

1. clean checkout + matching expected HEAD -> PASS;
2. tracked modification -> `MISSION_HOST_PREFLIGHT_DIRTY_WORKTREE`;
3. untracked file -> `MISSION_HOST_PREFLIGHT_DIRTY_WORKTREE`;
4. wrong expected HEAD -> `MISSION_HOST_PREFLIGHT_HEAD_MISMATCH`;
5. nested path instead of Git toplevel -> `MISSION_HOST_PREFLIGHT_REPO_ROOT_MISMATCH`.

`tools/devexec-mission-host-wrapper-contract.test.mjs` statically guards:

- mandatory `ExpectedHead`;
- preflight + postflight presence;
- required PASS-marker checks for all components;
- unique evidence directory identity without `New-Item -Force` reuse;
- Mission-base binding for both filesystem-sensitive probes and explicit `mission_probe_root` summary evidence;
- the host-lock probe's use of `DEVEXEC_MISSION_HOST_PROBE_ROOT` for both real-process scenarios;
- the file-identity probe's use of `DEVEXEC_FILE_IDENTITY_PROBE_ROOT`.

## Validation actually run in cloud

A source-faithful Node/Git execution using Node v22.16.0 and Git 2.47.3 ran the five focused preflight tests: **5/5 PASS**. `node --check` for the preflight module passed. A separate CLI probe confirmed a clean disposable checkout passes and a tracked modification returns exit code 2 with the dirty-worktree error. The static wrapper-contract regex/test logic also passed focused Node syntax/semantic probes after each extension.

The cloud runtime has no `powershell`/`pwsh`, so the final PowerShell host wrapper was **not executed** here. GitHub CI status, Windows/SHIRO-WS Mission-filesystem behavior, forced OS kill, Local Agent/Local Executor E2E, and power-loss durability remain unproven.

## Exact next action

On a clean SHIRO-WS checkout at the final reviewed branch HEAD, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\verify-devexec-mission-host-acceptance.ps1 -ExpectedHead <FINAL_REVIEWED_SHA>
```

Read back `SUMMARY.json` and all five persisted component logs/hashes. Confirm `mission_probe_root` is the runtime Mission base even if `EvidenceRoot` is redirected elsewhere. Any dirty source state, HEAD drift, missing component PASS marker, wrong-volume probe binding, or post-test repository mutation must prevent PASS. If this packet passes, continue the existing Local Agent/Local Executor and child-launch kill/restart matrix. Do not broaden into `GOAL_PATCH` / `supersede_current_goal` until Mission reliability acceptance closes.
