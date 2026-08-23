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
4. runs the existing Mission reliability, file-identity, and host-lock checks;
5. persists a `04-repo-postflight` check pinned to the reviewed HEAD;
6. emits `SUMMARY.json` schema v2 only after both checkout guards and all component marker checks pass.

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
- unique evidence directory identity without `New-Item -Force` reuse.

## Validation actually run in cloud

A source-faithful Node/Git execution using Node v22.16.0 and Git 2.47.3 ran the five focused preflight tests: **5/5 PASS**. `node --check` for the preflight module passed. A separate CLI probe confirmed a clean disposable checkout passes and a tracked modification returns exit code 2 with the dirty-worktree error. The exact committed static wrapper-contract test source also passed `node --check`.

The cloud runtime has no `powershell`/`pwsh`, so the final PowerShell host wrapper was **not executed** here. GitHub CI status, Windows/SHIRO-WS filesystem behavior, forced OS kill, Local Agent/Local Executor E2E, and power-loss durability remain unproven.

## Exact next action

On a clean SHIRO-WS checkout at the final reviewed branch HEAD, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\verify-devexec-mission-host-acceptance.ps1 -ExpectedHead <FINAL_REVIEWED_SHA>
```

Read back `SUMMARY.json` and all five persisted component logs/hashes. Any dirty source state, HEAD drift, missing component PASS marker, or post-test repository mutation must prevent PASS. If this packet passes, continue the existing Local Agent/Local Executor and child-launch kill/restart matrix. Do not broaden into `GOAL_PATCH` / `supersede_current_goal` until Mission reliability acceptance closes.
