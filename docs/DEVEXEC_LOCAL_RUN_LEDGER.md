# Dev Exec local run ledger

Local Worker runs may emit one parent-owned JSON record per run using schema
`devexec.local-run-record/v1`. The record contains only bounded logical IDs,
numeric timings/resources, enums, Git commit IDs, and SHA-256 digests. It does
not contain prompts, source text, environment variables, command strings,
absolute paths, URLs, process identifiers, or provider response bodies.

The default directory is `%LOCALAPPDATA%\ChatGPTMCPProbe\devexec-local-run-ledger`.
Use `--ledger-dir <dir>` to select an explicit directory. A record is written
through a temporary file and atomic rename; a duplicate `run_id` fails without
replacing the existing record. Ledger failures are reported as observability
metadata and never change the Task/Result outcome.

Read-only summary:

```text
node tools/devexec.mjs runtime metrics summarize <ledger-dir>
```

The summary reports record count, DONE count/rate, and wall-time p50/p95. It
ignores unrelated or malformed JSON files and never mutates the directory.
