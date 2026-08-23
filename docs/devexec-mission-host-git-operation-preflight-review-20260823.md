# Dev Exec Mission host Git-operation preflight review — 2026-08-23

Status: cloud adversarial review / implementation-ready reliability repair.

## Finding

The Mission host acceptance packet already pins `ExpectedHead` and runs a clean-worktree preflight before and after its components. That is necessary, but `git status --porcelain` being empty does not by itself prove the repository is outside an unfinished Git transaction. Git records merge, cherry-pick, revert, rebase, sequencer, and bisect state under the repository Git directory.

A host packet attributed to an exact reviewed commit should not begin while one of those operations is still in progress, even if HEAD matches and the worktree currently appears clean. Treating that state as authoritative evidence risks binding the packet to a repository whose transactional state has not settled.

A focused real-Git probe reproduced the exact gap: after creating a normal commit, writing only the repository's resolved `MERGE_HEAD` state file left `git status --porcelain=v1 -z --untracked-files=all` at **0 bytes** while `MERGE_HEAD` was present. The prior clean-worktree criterion therefore accepted a state that still carried merge-transaction metadata.

## Repair

`tools/devexec-mission-host-preflight.mjs` now checks the following Git state paths with `git rev-parse --git-path` after exact HEAD validation and before accepting the worktree:

- `MERGE_HEAD`
- `CHERRY_PICK_HEAD`
- `REVERT_HEAD`
- `rebase-merge`
- `rebase-apply`
- `sequencer/todo`
- `BISECT_START`

If any is present, preflight fails closed with `MISSION_HOST_PREFLIGHT_GIT_OPERATION_IN_PROGRESS` and records the operation and resolved Git-state path. The ordinary success report records `git_operation: null`.

The host wrapper already calls this preflight before all Mission components and again after them, so the stronger guard automatically applies at both evidence boundaries without broadening the host packet.

## Regression coverage

`tools/devexec-mission-host-preflight.test.mjs` adds two clean-worktree transaction-state regressions:

1. `MERGE_HEAD` present -> preflight rejects with operation `merge`.
2. `rebase-merge` directory present -> preflight rejects with operation `rebase-merge`.

The existing clean, tracked-dirty, untracked-dirty, wrong-HEAD, and nested-root cases remain covered.

Cloud validation actually run against the submitted/read-back source using Node and temporary real Git repositories:

- `node --check tools/devexec-mission-host-preflight.mjs`: PASS.
- `node --test tools/devexec-mission-host-preflight.test.mjs`: **7/7 PASS**, 0 failures.
- Independent real-Git gap probe: `STATUS_BYTES=0` with `MERGE_HEAD=yes`, confirming the old status-only predicate could miss the transaction state.

This is not a full repository checkout verifier, GitHub CI, PowerShell host packet, or Windows/SHIRO-WS acceptance result.

## Exact next acceptance

On the reconciled exact review head, run the ordinary Mission reliability verifier first:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\verify-devexec-mission-constraint-continuation.ps1
```

Then run the pinned SHIRO-WS host acceptance packet on a normal clean repository state. Do not place the active development checkout into a merge/rebase state merely to test the negative path; the temporary-repository regression covers that failure class deterministically. Read back `SUMMARY.json`, `VERIFICATION.json`, their SHA-256 values, all five component logs/hashes, and `mission_probe_root` before continuing to Local Agent / Local Executor and the remaining forced-kill acceptance matrix.

`GOAL_PATCH / supersede_current_goal` remains outside this repair and should stay PENDING until Mission reliability acceptance closes.
