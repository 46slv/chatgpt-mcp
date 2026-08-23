# Dev Exec Mission RAW nested Git metadata review — 2026-08-23

Status: dedicated Worker B adversarial review; SHIRO-WS host acceptance still required.

## Starting authority

Reviewed Worker A head: `automation/devexec-mission-raw-snapshot-tree-20260823@aa64e8ccb0f80bd88201ef19897ac036cf68ad06`.

The RAW bootstrap is intentionally designed to reconstruct the exact reviewed source tree and exact reviewed commit `3778734b6fc1a9e22b59adaa49803ac1daca49e2` / tree `ddc1f9ed6b09421b441f14a4afdc0137d68ba148`, then reuse the unchanged clean-checkout Mission host preflight. Direct inspection of `devexec-mission-host-preflight.mjs`, the host PowerShell packet, and the ordinary Mission verifier found no required parent-history traversal in those orchestration layers; their direct Git queries are HEAD/top-level/branch/status only. The parentless exact-commit contract therefore remains viable for the current packet, subject to real-host execution.

## New false-clean finding

The original RAW tree verifier passed the same `ignoreNames` set through every recursive directory walk. With the default `ignoreNames=[".git"]`, this silently ignored **every nested `.git` entry**, not only the bootstrap-owned root `.git` metadata directory.

That is not source-neutral. A focused real-Git reproduction showed:

1. commit a normal tracked file and record the Git tree;
2. create `sub/.git/evil` after the commit;
3. `git status --porcelain=v1 --untracked-files=all` remains empty;
4. `git add -A && git write-tree` remains equal to the original tree.

Therefore the previous combination of RAW tree equality + clean Git status could classify a filesystem containing extra nested Git metadata as exact/clean. Such metadata can change Git repository discovery for commands run below that path even though it is absent from the source tree and hidden by ordinary status.

A second ambiguity existed at the root: `fs.existsSync(root/.git)` follows symlinks, so a dangling `.git` symlink can return false even though the directory entry exists. Pre-bootstrap authority must reject any pre-existing root `.git` entry, not only entries whose targets exist.

## Repair

`tools/devexec-mission-raw-tree.mjs` now distinguishes root metadata from nested filesystem content:

- only the root-level ignored `.git` entry may be skipped for post-bootstrap source verification;
- nested `.git` directory/file/symlink entries fail closed as `MISSION_RAW_SNAPSHOT_NESTED_GIT_METADATA_FORBIDDEN`;
- Windows comparison is case-insensitive for the nested `.git` name;
- the result explicitly records `nested_git_metadata: FORBIDDEN`.

`tools/devexec-mission-raw-git-bootstrap.mjs` now uses `lstatSync` semantics to detect any pre-existing root `.git` directory entry, including a dangling symlink, before `git init`.

Regression coverage was extended so the committed tests require:

- non-empty nested `.git` metadata to be rejected even though Git porcelain status hides it;
- an empty nested `.git` directory to be rejected rather than disappearing as an empty Git-tree directory;
- bootstrap rejection before root `.git` creation when nested metadata exists;
- on non-Windows hosts, a dangling root `.git` symlink to be rejected as pre-existing metadata.

The existing root `.git` ignore remains necessary for the post-bootstrap exact-tree check and is intentionally not removed.

## Validation actually performed

- GitHub source/branch readback and compare against exact Worker A head.
- Real local Git reproduction: nested `sub/.git/evil` left porcelain status empty and left `git write-tree` unchanged.
- Focused fixed-semantics filesystem probe rejected the nested `.git` state: `NESTED_GIT_FALSE_CLEAN_REPRO=PASS`.
- Dangling symlink probe confirmed `existsSync` returns false while `lstatSync` still sees the `.git` entry: `DANGLING_GIT_LSTAT_GUARD=PASS`.
- Existing host preflight, host wrapper, and ordinary reliability orchestrator were source-reviewed for direct ancestry requirements; none of their direct Git queries require the parent object.

Not claimed here: full committed Node test bundle on a repository checkout, GitHub CI, SHIRO-WS/NTFS RAW reconstruction, Windows case-insensitive nested `.git` regression, PowerShell host packet, Local Agent/Local Executor E2E, forced-kill matrix, or power-loss/fsync durability.

## Exact next action

Worker A should reconcile this focused review branch, run the full ordinary Mission reliability verifier on a real checkout, and preserve the exact reviewed source commit/tree contract. Then on SHIRO-WS reconstruct the isolated RAW mirror, require tree `ddc1f9ed6b09421b441f14a4afdc0137d68ba148`, restore exact HEAD `3778734b6fc1a9e22b59adaa49803ac1daca49e2`, verify clean status, run the unchanged host packet, and read back `SUMMARY.json`, `VERIFICATION.json`, hashes/logs, and Mission probe root. A mirror containing any nested `.git` metadata must fail before bootstrap.

Keep `GOAL_PATCH / supersede_current_goal`, Control API/service, and GUI behind DEV-002 reliability closure.
