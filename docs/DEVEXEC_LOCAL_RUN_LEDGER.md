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

The writer cleans up the temporary file it owns on write, fsync, link, or
unlink failure and retries only that invocation's bounded temp name. A process
terminated abruptly (for example, `TerminateProcess` or power loss) can leave
an orphaned `.tmp-*` file; readers ignore non-`<run_id>.json` names, and no
directory-wide cleanup is attempted automatically.

The v1 record keeps the explicit `availability` enum and its derived boolean
`available` field while separating
`harness.parent_measured`, `harness.harness_reported`, and
`harness.provider_usage`. Parent wall/lifecycle measurements are authoritative.
When constructing a record, `availability` is accepted only as one of the
exact enum values (`AVAILABLE`, `UNAVAILABLE`, `NOT_COLLECTED`) and is mapped
to the matching boolean (or `null`); conflicting or unknown aliases are
rejected rather than silently converted to `null`.
Git attribution stores bounded before/after status and SHA fingerprints;
pre-existing dirty paths are excluded unless their status or fingerprint changes
during the run.
Parent evidence uses `lstat` link counts and marks any regular file with
`nlink > 1` as invalid (`hard_link_paths`); such paths cannot be read, patched,
or attributed. Directory link counts are not treated as hard-link aliases.

Read-only summary:

```text
node tools/devexec.mjs runtime metrics summarize <ledger-dir>
```

The summary reports record count, DONE count/rate, and wall-time p50/p95. It
ignores unrelated or malformed JSON files and never mutates the directory.
