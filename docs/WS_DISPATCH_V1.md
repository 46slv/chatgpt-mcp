# WS Dispatch v1 — prebuild contract

Status: cloud/pre-host candidate. This slice is intentionally independent of checkpoint autoreport PR #24.

## Goal

Reduce Remote Desktop Commander usage from many low-level remote calls per task to one bounded job submission. The Windows host performs the high-volume read/edit/test/MCP loop locally and emits one durable terminal result.

```text
ChatGPT
  -> one remote job submission
  -> WS Dispatch file queue
  -> local Worker (Muse first; Codex/Luna later)
  -> local repo / CLI / MCP / application
  -> terminal result + evidence
  -> checkpoint/report adapter after PR #24 is qualified
```

## v1 ownership boundary

- ChatGPT owns user-intent compilation: `goal`, observable `done`, authority, and requested reply mode.
- WS Dispatch owns job identity, queue claim, terminal receipt, no-blind-retry semantics, and Worker launch.
- The Worker owns the bounded execution loop inside the supplied authority.
- PR #24 / checkpoint autoreport will later own exact-bound ChatGPT REPORT/CONSULT delivery. This prebuild does not import or duplicate that state machine.

## File queue

Default host root is expected to be a machine-local path under `%LOCALAPPDATA%`; the exact installation path remains a host decision.

```text
<root>/
  inbox/       newly submitted immutable jobs
  active/      atomically claimed jobs
  results/     write-once terminal receipts
  evidence/    JSONL/log/evidence artifacts referenced by results
```

Submission becomes visible only after a temp-file durable write and rename. Claim is an atomic rename from `inbox` to `active`.

A `job_id` is globally unique within one dispatch root. If the same id already appears in queue, active state, or terminal results, submission fails closed.

## Crash / ambiguity contract

An `active/<job>.json` without a matching terminal result after dispatcher restart is **not requeued**. Recovery writes one `AMBIGUOUS` terminal result:

- no blind Worker resend;
- no assumption that workspace mutation did or did not occur;
- reconcile live repository/runtime/application state before any retry;
- retry, when authorized, must use a new job identity.

This deliberately matches the checkpoint relay rule that ambiguous external delivery is not retry authority.

## Worker lanes

v1 protocol reserves:

- `muse` — first host lane; OpenCode CLI/MCP worker.
- `codex-luna` — later lane after actual model/provider routing is re-qualified.
- `auto` — reserved for a deterministic rule router; not an AI router.

The prebuild includes an OpenCode command builder using `opencode run --dir ... --model ... --agent ... --format json`. Live OpenCode execution remains a host qualification item.

## Authority

v1 accepts only:

- `read-only`
- `workspace-write`

It intentionally does not include `full-machine`, elevation, credential access, destructive external actions, publishing, or unrelated filesystem mutation. New authorities require an explicit protocol revision or reviewed extension.

## PR #24 integration seam

After checkpoint autoreport is host-qualified, terminal Worker handling adds a thin adapter:

```text
terminal ws-dispatch.result
  -> checkpoint_save(
       mode = job.reply.mode,
       next/approach/done_for_next derived from terminal semantic state,
       evidence_refs = result.evidence_refs
     )
```

Do not copy checkpoint identity, target binding, delivery claims, or receipt logic into WS Dispatch. The checkpoint subsystem remains the single owner of REPORT/CONSULT delivery semantics.

## Acceptance before host deployment

Already cloud-verified in this slice:

- job validation fails closed on unknown fields/authority expansion;
- duplicate `job_id` is rejected;
- claim moves exactly one queued job to active state;
- terminal result is write-once and correlated to an active job;
- interrupted active job becomes `AMBIGUOUS` and is not requeued;
- OpenCode argv/prompt is compiled from the bounded contract.

Still requires SHIRO-WS after PR #24 work is no longer blocking:

1. choose/install machine-local dispatch root;
2. add dispatcher process/service lifecycle and single-instance guard;
3. run one disposable read-only Muse job with real `opencode --format json` evidence;
4. run one disposable workspace-write read/edit/test/repair job;
5. verify Remote Commander needs only job submission, not process polling;
6. connect terminal result to qualified checkpoint REPORT;
7. prove end-to-end `one remote submission -> local execution -> automatic exact-chat report`;
8. only then add/re-qualify Codex/Luna and deterministic `auto` routing.
