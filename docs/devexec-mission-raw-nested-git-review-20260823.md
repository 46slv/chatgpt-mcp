# Dev Exec Mission RAW nested Git metadata / Git authority review — 2026-08-23

Status: dedicated Worker B adversarial review; SHIRO-WS host acceptance still required.

## Starting authority

Reviewed Worker A head: `automation/devexec-mission-raw-snapshot-tree-20260823@aa64e8ccb0f80bd88201ef19897ac036cf68ad06`.

The RAW bootstrap is intentionally designed to reconstruct the exact reviewed source tree and exact reviewed commit `3778734b6fc1a9e22b59adaa49803ac1daca49e2` / tree `ddc1f9ed6b09421b441f14a4afdc0137d68ba148`, then reuse the unchanged clean-checkout Mission host preflight. Direct inspection of `devexec-mission-host-preflight.mjs`, the host PowerShell packet, and the ordinary Mission verifier found no required parent-history traversal in those orchestration layers; their direct Git queries are HEAD/top-level/branch/status only. The parentless exact-commit contract therefore remains viable for the current packet, subject to real-host execution.

## False-clean finding 1 — nested `.git`

The original RAW tree verifier passed the same `ignoreNames` set through every recursive directory walk. With the default `ignoreNames=[".git"]`, this silently ignored **every nested `.git` entry**, not only the bootstrap-owned root `.git` metadata directory.

That is not source-neutral. A focused real-Git reproduction showed:

1. establish a normal indexed source tree;
2. create `sub/.git/evil` afterward;
3. `git status --porcelain=v1 --untracked-files=all` is unchanged by that addition;
4. `git add -A && git write-tree` remains equal to the original tree.

Therefore the previous combination of RAW tree equality + clean/unchanged Git status could classify a filesystem containing extra nested Git metadata as exact/clean. Such metadata can change Git repository discovery for commands run below that path even though it is absent from the source tree and hidden by ordinary status.

A second ambiguity existed at the root: `fs.existsSync(root/.git)` follows symlinks, so a dangling `.git` symlink can return false even though the directory entry exists. Pre-bootstrap authority must reject any pre-existing root `.git` entry, not only entries whose targets exist.

## Authority finding 2 — inherited Git environment can redirect `git -C`

`execFileSync("git", ["-C", root, ...])` inherited the worker/operator process environment. A real Git reproduction confirmed that setting `GIT_DIR` to another repository causes `git -C <requested-root> rev-parse HEAD` to resolve the foreign repository's HEAD. Even `GIT_DIR=""` changes Git behavior and makes repository discovery fail rather than acting as an unset variable. Related worktree/index/object variables, `GIT_CONFIG_COUNT`/key-value injection, and explicit global/system/config-parameter environment variables can similarly change which repository/index/object/config authority Git uses.

This matters twice: bootstrap itself must never mutate an unrelated repository, and a bootstrap that silently sanitizes only its own child commands would still leave the subsequent ordinary host packet running in a contaminated operator environment.

The bootstrap now therefore does both:

- **precheck:** presence of repository-routing variables (including empty values), explicit global/system/config-parameter authority, non-zero `GIT_CONFIG_COUNT`, or injected config key/value variables causes `MISSION_RAW_SNAPSHOT_INHERITED_GIT_ENV_FORBIDDEN` before source verification or any Git mutation;
- **child isolation:** all bootstrap Git children additionally strip routing/config-injection variables, disable system/global Git config and system attributes, and disable replace objects.

A successful bootstrap can consequently be followed by the unchanged host packet in the same operator shell without silently switching Git authority through those inherited variables. For maximum host-evidence determinism, the host invocation should additionally isolate ordinary global/system Git config after bootstrap (for example by setting `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_COUNT=0`, and `GIT_CONFIG_GLOBAL` to a known nonexistent path under the reconstructed `.git` directory for the child host process). SHIRO-WS execution remains the authority for that boundary.

## Repair

`tools/devexec-mission-raw-tree.mjs` now distinguishes root metadata from nested filesystem content:

- only the root-level ignored `.git` entry may be skipped for post-bootstrap source verification;
- nested `.git` directory/file/symlink entries fail closed as `MISSION_RAW_SNAPSHOT_NESTED_GIT_METADATA_FORBIDDEN`;
- Windows comparison is case-insensitive for the nested `.git` name;
- the result explicitly records `nested_git_metadata: FORBIDDEN`.

`tools/devexec-mission-raw-git-bootstrap.mjs` now:

- uses `lstatSync` semantics to detect any pre-existing root `.git` directory entry, including a dangling symlink, before `git init`;
- rejects inherited Git routing/config authority before mutation, including empty routing variables;
- runs its own Git children with isolated config/object-routing semantics;
- records `git_environment: PRECHECKED_AND_SANITIZED` on success.

Regression coverage was extended so the committed tests require:

- non-empty nested `.git` metadata to be rejected while proving Git porcelain and index-tree observations are unchanged relative to the pre-injection baseline;
- an empty nested `.git` directory to be rejected rather than disappearing as an empty Git-tree directory;
- bootstrap rejection before root `.git` creation when nested metadata exists;
- on non-Windows hosts, a dangling root `.git` symlink to be rejected as pre-existing metadata;
- inherited `GIT_DIR` / worktree / index / object / config injection to fail before root bootstrap mutation while the foreign repository remains unchanged.

The existing root `.git` ignore remains necessary for the post-bootstrap exact-tree check and is intentionally not removed.

## Validation actually performed

- GitHub source/branch readback and compare against exact Worker A head.
- Real local Git reproduction: adding nested `sub/.git/evil` did not change porcelain status and did not change `git write-tree` relative to the pre-injection baseline.
- Focused fixed-semantics filesystem probe rejected the nested `.git` state: `NESTED_GIT_FALSE_CLEAN_REPRO=PASS`.
- Dangling symlink probe confirmed `existsSync` returns false while `lstatSync` still sees the `.git` entry: `DANGLING_GIT_LSTAT_GUARD=PASS`.
- A source-faithful reconstruction of the updated RAW tree module and committed regression cases passed **6/6** after correcting the regression fixture to compare Git status against its staged pre-injection baseline rather than incorrectly assuming the helper created a committed-clean worktree.
- A source-faithful exact-bootstrap focused suite passed **3/3**: parentless exact HEAD restoration/clean status, nested `.git` rejection before root metadata creation, and dangling root `.git` symlink rejection.
- Real Git proved `GIT_DIR=<foreign> git -C <requested-root> rev-parse HEAD` resolves the foreign HEAD. Source-faithful bootstrap probes passed for internal environment isolation and then for fail-closed inherited-Git precheck. A separate real-Git probe confirmed `GIT_DIR=""` itself is behavior-changing and must not be treated as unset.
- Existing host preflight, host wrapper, and ordinary reliability orchestrator were source-reviewed for direct ancestry requirements; none of their direct Git queries require the parent object.

Not claimed here: full committed Node test bundle on a repository checkout, GitHub CI, SHIRO-WS/NTFS RAW reconstruction, Windows case-insensitive nested `.git` regression, PowerShell host packet, Local Agent/Local Executor E2E, forced-kill matrix, or power-loss/fsync durability. Global/system Git configuration isolation in the unchanged `3778734...` host packet itself is also not claimed by this cloud run; it is an explicit host-launch condition for the next acceptance.

## Exact next action

Worker A should reconcile this focused review branch and run the full ordinary Mission reliability verifier on a real checkout. Then on SHIRO-WS, start from a shell with no Git routing/config-injection variables, reconstruct the isolated RAW mirror, require tree `ddc1f9ed6b09421b441f14a4afdc0137d68ba148`, restore exact HEAD `3778734b6fc1a9e22b59adaa49803ac1daca49e2`, and verify clean status. After bootstrap, launch the ordinary verifier and unchanged host packet under isolated global/system Git config in that same controlled shell; read back `SUMMARY.json`, `VERIFICATION.json`, hashes/logs, and Mission probe root. A mirror containing nested `.git` metadata or an inherited Git authority variable must fail before bootstrap.

Keep `GOAL_PATCH / supersede_current_goal`, Control API/service, and GUI behind DEV-002 reliability closure.
