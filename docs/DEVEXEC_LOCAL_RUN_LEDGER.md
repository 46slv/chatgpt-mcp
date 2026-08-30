# Dev Exec local run ledger

Local Worker runs may emit one parent-owned JSON record per run using schema
`devexec.local-run-record/v1`. The record contains only bounded logical IDs,
numeric timings/resources, enums, Git commit IDs, and SHA-256 digests. It does
not contain prompts, source text, environment variables, command strings,
absolute paths, URLs, process identifiers, or provider response bodies.

The default directory is `%LOCALAPPDATA%\ChatGPTMCPProbe\devexec-local-run-ledger`.
Use `--ledger-dir <dir>` to select an explicit directory. A record is written
through a same-filesystem temporary file and atomic no-replace hard-link; a duplicate `run_id` fails without
replacing the existing record. Ledger failures are reported as observability
metadata and never change the Task/Result outcome.

The temporary file is opened once with an exclusive `wx` descriptor, written
and fsynced on that same descriptor, closed, then `lstat`-checked and linked.
The writer never reopens a temporary path by name and compares `fstat`/`lstat`
identity where the platform exposes it.

The writer cleans up the temporary file it owns on write, fsync, link, or
unlink failure and retries only that invocation's bounded temp name. A process
terminated abruptly (for example, `TerminateProcess` or power loss) can leave
an orphaned `.tmp-*` file; readers ignore non-`<run_id>.json` names, and no
directory-wide cleanup is attempted automatically.

The v1 record keeps the explicit `availability` enum and its derived boolean
`available` field while separating
`harness.parent_measured`, `harness.harness_reported`,
`harness.adapter_reported`, and `harness.provider_usage`. Every metric carries
a `source` enum. Parent measurements contain only values captured by the
parent (wall time and lifecycle/resource samples). `resources.ram_mb` is the
parent RSS sample, `resources.vram_mb` is target-device GPU memory, and
`resources.gpu_utilization_pct` is target-device utilization; each has bounded
before/peak/after values and `AVAILABLE`/`NOT_COLLECTED` availability. The
sampler is read-only, cancellable, and never records provider PIDs, process
names, or paths. First-tool, tool-call, and token values are never labelled
`parent_measured`.
When constructing a record, `availability` is accepted only as one of the
exact enum values (`AVAILABLE`, `UNAVAILABLE`, `NOT_COLLECTED`) and is mapped
to the matching boolean (or `null`); conflicting or unknown aliases are
rejected rather than silently converted to `null`.
Git attribution stores bounded before/after status and SHA fingerprints;
pre-existing dirty paths are excluded unless their status or fingerprint changes
during the run.
Parent pre/post evidence recursively `lstat`s the Git root, every ancestor, and
every status/diff path before fingerprinting. Reparse points (including
junctions/symlinks) and regular files with `nlink > 1` are recorded in
`reparse_paths`/`hard_link_paths`; `invalid_paths` is true and such paths are
never read, patched, fingerprinted, or attributed. Safety inspection covers
all paths even when the bounded evidence list is truncated.

Read-only summary:

```text
node tools/devexec.mjs runtime metrics summarize <ledger-dir>
```

The summary reports record count, DONE count/rate, and wall-time p50/p95. It
ignores unrelated or malformed JSON files and never mutates the directory.
