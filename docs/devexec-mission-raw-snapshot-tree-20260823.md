# Dev Exec Mission exact RAW snapshot bootstrap — 2026-08-23

Status: cloud implementation on a dedicated branch; SHIRO-WS execution still required.

## Why this exists

SHIRO-WS has a green non-host Mission reliability result, but normal Git transport cannot currently obtain the reviewed host-acceptance commit. `raw.githubusercontent.com` remains reachable. The existing host preflight is correct to require an exact HEAD and clean worktree, so this work does **not** weaken it.

Reviewed continuation authority at implementation start:

- commit: `3778734b6fc1a9e22b59adaa49803ac1daca49e2`
- tree: `ddc1f9ed6b09421b441f14a4afdc0137d68ba148`
- branch: `automation/devexec-mission-host-writer-strict-utf8-reconciled-20260823`

A recursive GitHub tree readback found no `100755` or `120000` entries, so the reviewed tree is compatible with Windows RAW materialization as ordinary `100644` files.

## Exact-tree proof

`tools/devexec-mission-raw-tree.mjs` reconstructs canonical Git identity directly from filesystem bytes: exact Git blob hashes, recursive tree entries, Git pathname ordering, modes, and root tree SHA-1. `.git` is ignored; empty directories do not participate; unsupported filesystem entry types fail closed. `MISSION_RAW_SNAPSHOT_TREE=PASS` is emitted only for an exact expected-tree match.

`tools/devexec-mission-raw-tree.test.mjs` compares the implementation against real `git write-tree`, checks non-ASCII names/arbitrary bytes, ignores `.git` and empty directories, rejects byte drift, and checks CLI PASS-marker behavior.

Cloud validation: 4/4 focused tests PASS, plus a supplemental randomized Git oracle with 100/100 generated trees matching `git write-tree` exactly.

## Exact reviewed commit restoration

`tools/devexec-mission-raw-git-bootstrap.mjs` runs only after exact-tree proof and rejects any pre-existing `.git`. It accepts raw reviewed commit-object bytes and proves:

1. the commit bytes hash to the exact expected commit SHA;
2. the commit object's `tree` header equals the expected tree;
3. after `git init` + `git add -A`, `git write-tree` still equals the expected tree;
4. `git hash-object -t commit -w --stdin` stores the exact reviewed commit object;
5. `git rev-parse HEAD` equals the reviewed commit;
6. `git status --porcelain=v1 --untracked-files=all` is empty;
7. the independent raw-tree verifier still reports the exact expected tree.

The parent object does not need to exist locally for these checks. Commands that traverse ancestry may fail and are outside this fallback's contract.

`tools/devexec-reviewed-commit-3778734.commit` pins the exact reviewed commit-object bytes. `git hash-object -t commit` over that artifact equals `3778734b6fc1a9e22b59adaa49803ac1daca49e2`; its first header is the exact `ddc1f9ed...` tree. The commit message intentionally has no trailing newline because adding one changes the SHA.

## Existing host preflight remains unchanged

The current `devexec-mission-host-preflight.mjs` checks exact repository root, exact `git rev-parse HEAD`, and clean porcelain status. The exact-commit bootstrap was tested against that existing preflight without a RAW-specific bypass.

Cloud validation using real Git/Node processes: **20/20 independently generated exact-commit bootstraps passed the existing host preflight**, with the referenced parent commit deliberately absent after bootstrap.

This supersedes the earlier synthetic-carrier/raw-source-mode idea. The intended fallback is now:

```text
RAW bytes -> exact Git-tree proof -> exact commit-object proof/import -> unchanged clean-checkout preflight -> unchanged host acceptance packet
```

The ordinary Mission reliability verifier now syntax-checks both RAW modules and runs both RAW regression suites.

## SHIRO-WS sequence

Use an isolated RAW mirror, never the active dirty checkout. Materialize the exact reviewed source bytes, then run the verifier/bootstrap from an external trusted copy:

```text
node devexec-mission-raw-tree.mjs --root <RAW_MIRROR> --expected-commit 3778734b6fc1a9e22b59adaa49803ac1daca49e2 --expected-tree ddc1f9ed6b09421b441f14a4afdc0137d68ba148
node devexec-mission-raw-git-bootstrap.mjs --root <RAW_MIRROR> --expected-commit 3778734b6fc1a9e22b59adaa49803ac1daca49e2 --expected-tree ddc1f9ed6b09421b441f14a4afdc0137d68ba148 --commit-object devexec-reviewed-commit-3778734.commit
```

Then independently require tree=`ddc1f9ed...`, HEAD=`3778734...`, clean worktree, ordinary Mission reliability PASS, and the unchanged host packet pinned to `3778734...` with `SUMMARY.json` / `VERIFICATION.json` readback.

## Remaining boundaries

NOT_RUN / unproven on SHIRO-WS: exact RAW tree/bootstrap on NTFS, Windows strict UTF-8 writer regression on the reconciled source, full pinned host packet, Local Agent/Local Executor E2E, remaining forced-kill matrix, and power-loss/fsync durability.

Do not expand `GOAL_PATCH / supersede_current_goal`, Control API/service, or GUI until DEV-002 reliability closes.

## Exact next action

Worker B should adversarial-review this exact-commit fallback and verify that no host component requires parent-history traversal. If clean, SHIRO-WS should update/reconstruct its isolated RAW mirror to exact `3778734...`, prove tree `ddc1f9ed...`, restore exact HEAD, then run the unchanged Mission verifier and host packet. Any source-byte/tree/commit/preflight mismatch must fail closed.
