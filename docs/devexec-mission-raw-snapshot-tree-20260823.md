# Dev Exec Mission raw-snapshot Git-tree verification — 2026-08-23

Status: cloud implementation on a dedicated branch; source-identity primitive only; does not by itself authorize host acceptance.

## Why this slice exists

Live SHIRO-WS evidence shows the ordinary Mission reliability bundle is green, but the pinned host-acceptance packet cannot currently obtain the reviewed commit through normal Git transport. `github.com`, `api.github.com`, `codeload.github.com`, and SSH-over-443 are unavailable from that host while `raw.githubusercontent.com` remains reachable. An isolated RAW mirror can therefore be constructed, but the existing host preflight correctly refuses to treat a directory without the exact Git checkout/HEAD as authoritative.

Do not weaken that existing clean-Git preflight. Instead, this slice adds an independent primitive that proves the complete filesystem snapshot is byte-for-byte and path-for-path equivalent to an expected Git tree before a future explicit `raw_snapshot` acceptance mode is considered.

Current reviewed continuation authority at implementation start:

- commit: `3778734b6fc1a9e22b59adaa49803ac1daca49e2`
- commit tree: `ddc1f9ed6b09421b441f14a4afdc0137d68ba148`
- source branch: `automation/devexec-mission-host-writer-strict-utf8-reconciled-20260823`

The commit/tree pair above was read from GitHub immediately before this dedicated branch was created.

## Implementation

`tools/devexec-mission-raw-tree.mjs` reconstructs Git object identity directly from a local filesystem snapshot:

1. Read every regular file as raw bytes.
2. Hash each file using the exact Git blob framing `blob <length>\0<bytes>` and SHA-1.
3. Recurse directories and build canonical Git tree entries with Git modes and binary object IDs.
4. Apply Git tree pathname ordering, including directory `/` ordering semantics.
5. Hash every tree with `tree <length>\0<body>`.
6. Compare the observed root tree SHA-1 with a required 40-hex expected tree.

`.git` metadata is ignored. Empty directories are absent from Git and therefore do not affect the result. On Windows regular files are treated as `100644`; on POSIX executable bits produce `100755`; symlinks use `120000` and hash their link target bytes. Unsupported filesystem entry types fail closed.

The CLI emits `MISSION_RAW_SNAPSHOT_TREE=PASS` only after an exact tree match and otherwise exits 2. `--expected-commit` is recorded as attribution metadata but tree equality is the actual filesystem proof.

Example for the reviewed continuation head:

```text
node tools/devexec-mission-raw-tree.mjs --root <RAW_MIRROR_ROOT> --expected-commit 3778734b6fc1a9e22b59adaa49803ac1daca49e2 --expected-tree ddc1f9ed6b09421b441f14a4afdc0137d68ba148
```

## Regression coverage

`tools/devexec-mission-raw-tree.test.mjs` uses real Git as an independent oracle on a synthetic repository and checks:

- the pure filesystem implementation exactly matches `git write-tree`, including prefix-neighbor names, nested paths, non-ASCII names, and arbitrary bytes;
- `.git` metadata and empty directories do not change source identity;
- one changed byte fails closed;
- the CLI emits the exact PASS marker only for a matching tree.

Cloud validation on Node v22.16.0 + Git reported 4/4 PASS and both files passed `node --check` before publication.

## Boundary: what this does not prove

This tool does **not** claim that a RAW mirror is already equivalent to a clean checkout for the existing host wrapper. It is deliberately not wired into `verify-devexec-mission-host-acceptance.ps1` yet. The existing wrapper still requires its exact clean-Git preflight and should remain unchanged until a separate reviewed source-mode contract binds raw-tree identity into SUMMARY/VERIFICATION evidence without pretending a synthetic/local commit is the reviewed Git commit.

It also does not prove Local Agent/Local Executor E2E, forced-kill timing, or power-loss/fsync durability.

## Exact next action

1. On SHIRO-WS, reconstruct an isolated RAW mirror of the exact reviewed continuation head and run this tree verifier against the GitHub-observed commit tree SHA.
2. If the tree matches, design/review an explicit `source_mode: raw_snapshot` host-preflight/evidence contract that records both `expected_commit` and `expected_tree` and repeats the tree check before and after the host packet.
3. Do not reuse the normal `expected_head == git rev-parse HEAD` assertion for a synthetic local commit and do not silently downgrade the clean-checkout contract.
4. If raw-snapshot mode is accepted and its evidence verifier is hardened, run the full SHIRO-WS host packet, then Local Agent/Local Executor and remaining kill/restart acceptance.

`GOAL_PATCH / supersede_current_goal`, Control API/service, and GUI remain gated behind DEV-002 reliability closure.
