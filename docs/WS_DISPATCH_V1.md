# WS Dispatch v1 — prebuild contract

Status: FIRST_USABLE on SHIRO-WS. Resident Muse/OpenCode execution, machine-local installation, Scheduled Task lifecycle, restart ambiguity, and one exact-bound REPORT have completed real-host acceptance.

## Goal

Reduce Remote Desktop Commander usage from many low-level remote calls per task to one bounded job submission. The Windows host performs the high-volume read/edit/test/MCP loop locally and emits one durable terminal result.

```text
ChatGPT
  -> one remote job submission
  -> WS Dispatch file queue
  -> local Worker (Muse first; Codex/Luna later)
  -> local repo / CLI / MCP / application
  -> terminal result + evidence
  -> durable checkpoint-link adapter
  -> existing checkpoint REPORT/CONSULT delivery
```

## Operator routing guard

Remote Desktop Commander / equivalent hosted remote-control channels are a **control plane**, not the iterative execution plane.

For one logical task:

- use native GitHub / Notion / Files connectors directly when they own the target state;
- if host-local work requires a read -> edit -> test -> repair loop, compile the whole bounded task into one WS Dispatch job;
- a remote-control channel may be used for one job submission/start and, when automatic REPORT is unavailable, one terminal-result readback;
- do not use repeated remote process/file calls for each shell command, test, poll, or repair step;
- if a second remote process call would be needed to continue ordinary execution, treat that as a routing failure and move the work into the local Worker instead;
- exception: bounded diagnosis of the local-job transport itself or a host-only emergency that cannot be expressed through an available local lane. Record the reason rather than silently falling back.

This gate exists because hosted Remote control has a scarce call budget and because high-frequency host work is both cheaper and more coherent when the local Worker owns the loop.

## Local submission and resident interface

This branch exposes a first-class local CLI around the durable queue:

```powershell
# Submit one immutable job JSON. This only queues; a resident dispatcher may claim it.
node .\tools\ws-dispatch-cli.mjs submit --job .\job.json

# The same submission can be piped through stdin, useful for a single bounded
# remote-control process call without a separate remote file-write operation.
Get-Content .\job.json -Raw | node .\tools\ws-dispatch-cli.mjs submit --stdin

# Inspect durable queue/result state without launching anything.
node .\tools\ws-dispatch-cli.mjs status --job-id <job-id>

# Until the Scheduled Task/service lifecycle is installed, a one-shot local
# dispatcher can execute exactly one queued job through the Muse/OpenCode lane.
node .\tools\ws-dispatch-cli.mjs run-once

# Foreground resident dispatcher. It owns one dispatcher lock, performs startup
# recovery once, sleeps on a bounded filesystem wait while idle, and drains one
# Muse/OpenCode job at a time.
node .\tools\ws-dispatch-cli.mjs serve
```

`--root` and `--checkpoint-state-root` remain explicit test/canary overrides. Installed operation deliberately omits them so submission, resident execution, and Scheduled Task startup resolve the same machine-local identity.

The installed steady state remains:

```text
one remote submit -> resident local dispatcher -> local Worker loop
                  -> terminal result -> checkpoint REPORT/CONSULT
```

## Machine-local identity

The formal v1 root is:

`%LOCALAPPDATA%/ChatGPTMCPProbe/ws-dispatch-v1`

This reuses the existing ChatGPTMCPProbe owner used by Dev Exec and checkpoint autoreport. It does not create another task manager or top-level product state owner. One config resolver owns the dispatch root, checkpoint state root, runtime release location, log path, and Scheduled Task name. `WS_DISPATCH_ROOT`, `CHECKPOINT_AUTOREPORT_STATE_ROOT`, and `WS_DISPATCH_TASK_NAME` are explicit operator/test overrides.

The root contains the durable queue plus `runtime/releases/<git-sha>/`, `runtime/installation.json`, and `logs/dispatcher.jsonl`. Queue/results/evidence and runtime releases have separate subtrees, so uninstalling the Scheduled Task does not remove execution history.

## Windows Scheduled Task lifecycle

WS Dispatch v1 uses a current-user Scheduled Task, not a Windows Service. Installation copies the exact built Git candidate into a versioned machine-local release and installs production dependencies there. The task never points at a PR worktree.

```powershell
npm run build
node .\tools\ws-dispatch-cli.mjs task-install
node .\tools\ws-dispatch-cli.mjs task-status
node .\tools\ws-dispatch-cli.mjs task-uninstall
```

Install/status/uninstall are idempotent. The task uses the current user with `Interactive` logon type and `Limited` run level, an at-logon trigger, hidden execution, `IgnoreNew`, three one-minute restart attempts, and an unlimited execution time for the resident process. Install starts the task immediately. Uninstall stops and unregisters it while preserving the dispatch root, queue, results, evidence, logs, installation receipt, and versioned runtime.

The installer requires a built `dist/chatgpt.js`, snapshots the exact Git HEAD, and runs `npm ci --omit=dev --ignore-scripts` inside the versioned runtime. Candidate canaries should use an explicit disposable `--root`; canonical acceptance uses the installed default root.

## v1 ownership boundary

- ChatGPT owns user-intent compilation: `goal`, observable `done`, authority, and requested reply mode.
- WS Dispatch owns job identity, queue claim, terminal receipt, no-blind-retry semantics, and Worker launch.
- The Worker owns the bounded execution loop inside the supplied authority.
- checkpoint autoreport owns exact-bound ChatGPT REPORT/CONSULT delivery. WS Dispatch only creates one linked checkpoint event from one immutable terminal result and does not duplicate the delivery state machine.

## File queue

The default host root is the formal machine-local identity documented above.

```text
<root>/
  inbox/       newly submitted immutable jobs
  active/      atomically claimed jobs
  results/     write-once terminal receipts
  archive/     immutable claimed jobs after terminalization
  evidence/    JSONL/log/evidence artifacts referenced by results
```

Submission becomes visible only after a temp-file durable write and rename. Claim is an atomic rename from `inbox` to `active`.

A `job_id` is globally unique within one dispatch root. If the same id already appears in queue, active state, or terminal results, submission fails closed.

## Crash / ambiguity contract

A terminal receipt is persisted before the active job is moved to `archive/`. If a crash leaves both `active/<job>.json` and a terminal result, restart recovery archives the active copy without rerunning it.

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

Terminal Worker handling uses a thin adapter:

```text
terminal ws-dispatch.result
  -> checkpoint_save(
       mode = job.reply.mode,
       next/approach/done_for_next derived from terminal semantic state,
       evidence_refs = result.evidence_refs
     )
```

Do not copy checkpoint identity, target binding, delivery claims, or receipt logic into WS Dispatch. The checkpoint subsystem remains the single owner of REPORT/CONSULT delivery semantics.

The adapter records a write-once job-to-checkpoint link. A durable claim is written before checkpoint creation; a leftover claim is `IN_FLIGHT_AMBIGUOUS` and never authorizes a second checkpoint. `reply.target_alias`, when supplied, must match the workspace's immutable checkpoint binding. Delivery still occurs only through `dispatchCheckpoint`.

The resident dispatcher calls the thin projection adapter after each terminal Worker result and at startup for any pre-existing terminal result. For `REPORT` and `CONSULT`, it then calls the existing checkpoint core's `dispatchCheckpoint` with the same `sendOnlyReply` / `blockingReply` transport used by checkpoint MCP tools. Existing checkpoint claims and receipts own dedupe, cached delivery, and ambiguous delivery semantics. WS Dispatch adds no second delivery state machine. `NONE` returns `SKIPPED` before loading or calling a ChatGPT transport.

## Acceptance before host deployment

Already cloud-verified in this slice:

- job validation fails closed on unknown fields/authority expansion;
- duplicate `job_id` is rejected;
- claim moves exactly one queued job to active state;
- terminal result is write-once and correlated to an active job;
- interrupted active job becomes `AMBIGUOUS` and is not requeued;
- OpenCode argv/prompt is compiled from the bounded contract.

Additional cloud-prebuilt pieces:

- single-instance dispatcher lock with safe stale-owner replacement;
- generic `dispatchNextJob` terminalization with runner exceptions converted to FAILED receipts;
- OpenCode process adapter with the exact native Windows `opencode.exe`, shell disabled, and local stdout/stderr evidence capture. `OPENCODE_EXECUTABLE` is an explicit exact-path override; the normal npm global path is resolved without executing the `.cmd` shell shim.

SHIRO-WS qualification rows:

1. focused resident/config/checkpoint tests pass on the exact candidate;
2. task install/status/uninstall readback matches the lifecycle contract;
3. one disposable read-only Muse job reaches a terminal receipt with real `opencode --format json` evidence;
4. one disposable workspace-write job performs its own read/edit/test/repair loop and records focused test evidence;
5. task restart converts active/no-result to `AMBIGUOUS` without a second Worker launch;
6. after Scheduled Task start, submission alone reaches terminal state;
7. when an exact checkpoint binding and ChatGPT transport session are available, one `REPORT` job reaches the existing checkpoint receipt with no hosted remote execution loop;
8. only then consider a separate revision for Codex/Luna or deterministic `auto` routing.

## SHIRO-WS acceptance — 2026-09-23

- Resident/config/checkpoint focused tests: 28 passed, 0 failed after the final shutdown hardening.
- Final full suite: 535 tests, 525 passed, 10 explicit skips, 0 failed; portability 3 passed; read-only preflight passed.
- Read-only Muse: `canary-ro-327006c` completed, reported `CANARY_READ_ONLY_VALUE=EPHEMERA-WS-DISPATCH-7d7bc0e`, and left the fixture clean.
- Workspace-write Muse: `canary-write-327006c` reproduced `41 !== 42`, changed only `value.mjs`, reran `npm test`, and recorded 1 passed / 0 failed in OpenCode JSONL evidence.
- Process crash/restart: `restart-ambiguous-327006c` was killed after reaching `ACTIVE`; restart wrote `AMBIGUOUS`, processed zero jobs, created no Worker evidence, and did not requeue.
- Scheduled Task: install/status/uninstall/reinstall readback confirmed current user, `Interactive`, `Limited`, hidden, `IgnoreNew`, restart count 3 / `PT1M`, and execution time limit `PT0S`. Uninstall preserved the terminal queue/result and versioned runtime.
- Submit-only scheduled acceptance: `scheduled-ro-b68e83e` reached `COMPLETED` after one queue submission while the installed task was already resident.
- Exact-bound REPORT E2E: `e2e-report-b68e83e` completed through Muse, created checkpoint `505006875447608106a05407b3a741c8cb2b584bb7f67cd260896f5862fb7030`, linked `report-fbe68cde0be15a95e7921f28`, and reached `DELIVERED` with `USER_TURN_ACK`; pending became empty.

The first real OpenCode attempt exposed Windows `spawn EINVAL` for `.cmd`; the accepted path now resolves the native `opencode.exe` and never passes Worker text through a command shell. Runtime installation similarly invokes `npm-cli.js` through the active `node.exe`. CDP checkpoint transport is disconnected during graceful shutdown through the existing browser cleanup contract without closing the caller-owned Chrome process or its tabs.
