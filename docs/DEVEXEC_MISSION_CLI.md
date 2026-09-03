# Dev Exec — Mission CLI and Codex Automation Interface

Status: PROPOSED / DESIGN AUTHORITY  
Last updated: 2026-09-03 JST  
Scope: non-interactive machine-facing CLI for Mission submission, exact Event attachment, observation, waiting, and canonical result retrieval  
Reviewed base: `main` at `7b65b1311b064414d5340337a0fe896e2d8f4fb6`

> **Implementation status note:** This document defines the target CLI contract. It does not claim that the Mission CLI commands below are implemented at the reviewed base.

> **Repository scope note:** This design belongs to Dev Exec as a system, not specifically to the ChatGPT MCP transport. It is colocated in `46slv/chatgpt-mcp` because this repository is currently the implementation home of Dev Exec.

Related authority:

- [`DEVEXEC_SELF_EVOLVING_ARCHITECTURE.md`](DEVEXEC_SELF_EVOLVING_ARCHITECTURE.md)
- [`DEVEXEC_MISSION_INTERFACE_AND_OBSERVABILITY.md`](DEVEXEC_MISSION_INTERFACE_AND_OBSERVABILITY.md)
- [`goals/DEV-EVT-001-OPERATOR-EVENT-INGRESS.md`](goals/DEV-EVT-001-OPERATOR-EVENT-INGRESS.md)
- [`goals/DEV-OBS-001-MISSION-OBSERVATORY.md`](goals/DEV-OBS-001-MISSION-OBSERVATORY.md)
- [`goals/DEV-CLI-001-CODEX-MISSION-CLI.md`](goals/DEV-CLI-001-CODEX-MISSION-CLI.md)

## 0. Executive summary

Dev Exec should expose a first-class CLI that Codex and other automation can use without scraping terminal prose, controlling a browser, guessing a current run, or depending on a long-lived interactive session.

The CLI is a thin client over the same Control Service and typed Event ingress used by every other interface:

```text
Codex / operator / automation
  -> devexec Mission CLI
  -> Control Service
  -> DEV-EVT-001 Event ingress
  -> durable Mission and fresh Episodes
  -> canonical MissionResult
```

The CLI must not become another Control Plane, executor, scheduler, or Mission store.

The intended machine workflow is:

```text
submit exact Request
  -> receive exact request_id / mission_id / event_id
  -> inspect or wait using that exact mission_id
  -> optionally attach a typed follow-up Event
  -> retrieve exactly one canonical terminal MissionResult
```

For Codex, the important properties are:

- stable versioned JSON or JSONL;
- no interactive questions in machine mode;
- exact identities and no `current` / `latest` / `--last` fallback;
- bounded waiting and resumable observation;
- coarse stable exit-code classes plus detailed structured status;
- diagnostics on stderr, protocol data on stdout;
- idempotent writes and explicit ambiguous-delivery behavior;
- request payloads through stdin/files rather than long or sensitive argv text;
- the same state and evidence semantics as the Mission Observatory.

## 1. Two Codex directions must remain distinct

Dev Exec already has a direction in which the Control Plane drives one exact persisted Codex thread through the Closed Goal Loop:

```text
Dev Exec -> exact bound Codex runtime/thread
```

The Mission CLI adds the opposite interaction direction:

```text
Codex -> Dev Exec Request/Event/inspection interface
```

These must not be conflated.

### Existing direction: Dev Exec to Codex

The current Closed Goal Loop owns:

- exact persisted Codex thread identity;
- exact native runtime binding;
- same-thread queue continuation;
- task-bound ChatGPT supervision;
- RELAY correlation and no-replay behavior.

### New direction: Codex to Dev Exec

The Mission CLI lets a Codex process act as an authorized external caller that can:

- submit a bounded Task or Consultation Request;
- attach a bounded follow-up Event to one exact Mission;
- inspect Mission/Episode/Event/runtime/evidence state;
- wait for a safe transition or terminal result;
- retrieve the canonical MissionResult.

Using the CLI does not grant Codex ownership of Mission state, Goal transitions, routing, authority, evidence truth, or process lifecycle.

A Mission may later choose Codex as an internal Executor, Goal Controller, or reviewer adapter. That role assignment remains parent-owned and must not be inferred merely because the request originated from Codex.

## 2. CLI placement

The existing repository already has one root command surface:

```text
devexec target ...
devexec goal ...
devexec agent ...
devexec runtime ...
devexec closed-loop ...
devexec run ...
devexec continue ...
devexec recover ...
```

The Mission interface should extend this root rather than introduce a second unrelated executable or hidden service-specific command path.

Candidate top-level additions:

```text
devexec mission ...
devexec observatory ...
```

The final spelling may change, but the command hierarchy and protocol contracts must remain coherent with the existing `devexec` entrypoint.

## 3. Candidate command surface

### 3.1 Submit a new Mission

```text
devexec mission submit --request <file|-> --json
```

The request document should contain the versioned `TASK` or `CONSULTATION` envelope, idempotency identity, requested authority, bounded payload reference, and optional budgets.

Successful admission returns one structured receipt containing at least:

```text
request_id
mission_id
event_id
idempotency_key
admission_status
state_revision
receipt_digest
```

A convenience form may exist for humans, but Codex/machine mode should prefer one bounded UTF-8 JSON document from stdin or a regular file.

### 3.2 Submit and wait

```text
devexec mission submit --request <file|-> --wait --timeout-ms <bounded> --json
```

This is a convenience composition of `submit` and `wait`; it must not create a separate execution path.

If the wait budget expires while the Mission remains valid and non-terminal, the command returns a structured non-terminal timeout/continuation result. It must not cancel the Mission or report it as failed merely because the calling process stopped waiting.

### 3.3 Attach a follow-up Event

```text
devexec mission followup --mission <exact-id> --event <file|-> --json
```

Required machine-mode properties:

- exact `mission_id`;
- explicit idempotency identity;
- no current/recent/focused Mission fallback;
- durable receipt before the caller may treat delivery as known;
- accepted, deferred, applied, duplicate, rejected, and blocked states remain distinct;
- the Event is never injected into an already-running Episode context.

### 3.4 Inspect one Mission

```text
devexec mission inspect --mission <exact-id> --json
```

Returns a bounded versioned Mission snapshot including current state revision, active Episode, pending/deferred Events, runtime/model attribution, blocker, and terminal-result reference.

This command is read-only and safe to retry.

### 3.5 Wait for a state condition

```text
devexec mission wait --mission <exact-id> \
  --until <terminal|event-applied|revision|episode-complete> \
  --timeout-ms <bounded> --json
```

A wait command observes canonical state. It does not infer completion from stdout text, provider utilization, disappearance of a process, or an agent's self-report.

The returned object should include:

- exact Mission identity;
- requested condition;
- whether the condition was satisfied;
- observed state revision;
- terminal status/result reference if any;
- bounded continuation cursor;
- timeout versus transport failure distinction.

### 3.6 Retrieve the terminal result

```text
devexec mission result --mission <exact-id> --json
```

Returns exactly the committed canonical MissionResult or a structured `NOT_TERMINAL` response. Repeated retrieval returns the same result identity and digest.

### 3.7 Read Events

```text
devexec mission events --mission <exact-id> \
  [--after <cursor>] [--follow] [--timeout-ms <bounded>] --jsonl
```

The stream must be resumable by a stable cursor and must not duplicate already acknowledged records unless explicitly requested.

Each JSONL line is one complete versioned record. Heartbeats, if used, must be typed and distinguishable from Events.

### 3.8 Read Episodes

```text
devexec mission episodes --mission <exact-id> \
  [--after <cursor>] --json
```

Returns bounded Episode summaries and lifecycle evidence without requiring raw conversations or chain-of-thought.

### 3.9 Runtime/model status

```text
devexec runtime status --json
```

The existing runtime command family should expose the same model-identity distinctions as the Observatory:

```text
configured_model
selected_model
loaded_model
active_episode_model
available_models
```

Runtime status must include source and freshness rather than guessing from old ledger records.

### 3.10 Observatory service

```text
devexec observatory serve
```

This may expose the loopback-only same-origin read-only Mission Observatory. It is separate from Mission execution and should use the same Control Service read models as CLI inspection.

## 4. Machine mode contract

Codex compatibility depends more on output discipline than on command naming.

### 4.1 Stdout and stderr

In `--json` mode:

```text
stdout = exactly one complete JSON document
stderr = bounded human/diagnostic messages only
```

In `--jsonl` mode:

```text
stdout = one complete JSON object per line
stderr = bounded diagnostics only
```

Required behavior:

- no banner, progress bar, ANSI escape, spinner, prose prefix, or usage text on stdout;
- no mixed JSON and human text;
- UTF-8 output;
- one trailing newline permitted/required by the command contract;
- unknown output schema version is a hard protocol error for strict clients;
- large evidence/log bodies are represented by bounded summaries and immutable references.

Human-readable mode may format output differently, but it must be explicitly separate from machine mode.

### 4.2 No interactive prompts

Machine mode must never pause for:

- missing argument clarification;
- confirmation;
- model selection;
- Mission selection;
- overwrite permission;
- login/browser interaction;
- retry choice.

Missing or ambiguous inputs fail with structured error output and a stable non-zero exit class.

### 4.3 Exact identities

Machine-mode mutating or waiting commands must require exact identities where applicable:

```text
mission_id
request_id
event_id
idempotency_key
expected_state_revision
cursor
result_id
```

No command may silently resolve:

```text
current Mission
latest Mission
most recent run
currently visible Observatory card
active process
browser focus
last Codex session
fuzzy title
```

A human convenience resolver may exist only as a separate explicit resolution command that returns an exact identity before any mutation.

## 5. Request and payload input

Long prompts and structured task definitions should not be passed directly in argv because command lines are difficult to quote reliably and may be visible through process inspection or shell history.

Preferred machine input:

```text
--request -        read one bounded JSON document from stdin
--request <file>   read one bounded regular UTF-8 file
--event -
--event <file>
```

Required safety:

- explicit maximum bytes;
- regular-file check and symlink/reparse-point policy;
- exact JSON schema/version validation;
- unknown fields rejected where they could hide typos or authority drift;
- no implicit path search;
- no automatic loading of neighboring files;
- payload body redaction/retention policy before persistence;
- large artifacts referenced by digest and runtime-owned location rather than embedded in Event journal rows.

Short text convenience flags may be added for interactive humans, but machine documentation should use structured stdin/files.

## 6. Idempotency and retry semantics

Read-only commands such as `inspect`, `result`, bounded list queries, and status reads may be retried.

Mutating commands must use a caller-stable idempotency key.

```text
same command intent + same idempotency key
  -> same durable receipt / same admitted Event or Mission
```

The CLI must not generate a fresh idempotency key during an automatic retry in machine mode.

If the CLI loses the response after submission:

1. it must not assume the Event failed;
2. it may repeat the same request only with the same idempotency identity;
3. the Control Service returns the existing receipt or an explicit conflict;
4. a different payload with the same key fails closed;
5. unknown delivery remains an explicit ambiguous state until reconciled.

The same rule applies when Codex invokes the CLI through another harness that may time out independently.

## 7. Bounded waiting and resumability

Codex tool calls and parent orchestrators should not require an unbounded open process.

Required behavior:

- every wait/follow operation accepts or inherits a bounded timeout;
- timeout means the caller stopped observing, not that the Mission was cancelled;
- the response includes an exact continuation cursor/state revision;
- a later command can resume inspection without replaying work;
- process interruption does not corrupt Mission state;
- cancellation is a separate explicit typed Event;
- heartbeat output, if provided, remains bounded and machine distinguishable;
- backpressure and maximum buffered records are defined outside the model.

A one-command blocking experience is useful, but durable Mission identity and resumable retrieval are the source of truth.

## 8. Exit-code classes

The exact numeric mapping should be frozen before implementation is declared stable. At minimum the CLI must distinguish these machine-useful classes:

```text
SUCCESS
INVALID_INVOCATION_OR_SCHEMA
REJECTED_OR_BLOCKED
NEEDS_HUMAN
TERMINAL_FAILED_OR_CANCELLED
CONTROL_SERVICE_UNAVAILABLE
WAIT_TIMEOUT_NON_TERMINAL
AMBIGUOUS_OR_RECONCILIATION_REQUIRED
PROTOCOL_VERSION_MISMATCH
```

Detailed status remains in the JSON body. Exit codes are a coarse shell routing signal and must not replace inspection of the typed response.

For example, an accepted asynchronous submission is shell success even though the Mission is not complete. A bounded wait timeout is not equivalent to Mission failure. `NEEDS_HUMAN`, `BLOCKED`, `FAILED`, and `CANCELLED` remain distinct in the response even if some shell environments require a coarser code grouping.

## 9. Error envelope

Machine-mode errors should use one versioned bounded shape, for example:

```json
{
  "protocol": "devexec.cli-error",
  "schema_version": 1,
  "command": "mission followup",
  "status": "REJECTED",
  "code": "MISSION_ID_REQUIRED",
  "message": "bounded human-readable explanation",
  "retryable": false,
  "ambiguous_delivery": false,
  "correlation_id": "...",
  "details_ref": null
}
```

Requirements:

- no stack trace on stdout;
- no credentials, cookies, authorization data, raw prompt, or sensitive payload body;
- stable reason code;
- explicit retryability and ambiguity where relevant;
- bounded message and details;
- correlation identity for durable diagnosis;
- programmer/debug stack may appear only in an explicit local diagnostic mode on stderr.

## 10. Role and three-axis attribution

The Mission architecture may internally separate:

```text
Task Execution
Goal Control
Mission Governance
```

The CLI is not a fourth reasoning axis. It is a transport and inspection adapter.

Episode/status output should preserve parent-assigned attribution such as:

```text
axis: TASK_EXECUTION | GOAL_CONTROL | MISSION_GOVERNANCE | DETERMINISTIC
role: WORKER | TASK_PLANNER | TECHNICAL_VERIFIER | MISSION_GOVERNOR | ...
```

A Codex caller may request work, but it cannot self-assign `MISSION_GOVERNANCE`, completion authority, or a higher side-effect class through CLI text or flags. Axis/role selection remains a validated Control Plane decision.

Similarly, a Codex adapter returning an Episode result must not be treated as independently verified merely because the CLI process exited successfully.

## 11. Shared read models with the Observatory

The CLI and Mission Observatory should not implement separate interpretations of state.

```text
canonical runtime state
  -> Control Service read models
       -> Mission CLI JSON/JSONL
       -> browser Observatory
```

They should share:

- Mission state enum and state revision;
- Event lifecycle and cursor semantics;
- Episode lifecycle and fresh-context proof;
- model identity distinctions;
- evidence/test/verifier attribution;
- resource metric availability/source;
- blocker and failure reason codes;
- terminal MissionResult identity;
- freshness/staleness rules;
- redaction and response bounds.

A disagreement between CLI and browser projection indicates a bug or stale client, not two acceptable sources of truth.

## 12. Control and authority boundary

The CLI process must not own:

- Mission persistence or state reduction;
- Event ordering or application decisions;
- Goal transition authority;
- role/model assignment;
- direct repository mutation;
- provider lifecycle implementation;
- process kill/restart policy;
- lease acquisition/release semantics;
- Codex thread selection or queue replay;
- ChatGPT target resolution or ambiguous-send retry;
- evidence acceptance;
- Mission completion truth.

It may:

- validate obvious local syntax before sending;
- submit typed requests to the Control Service;
- print durable receipts/read models;
- wait for bounded state changes;
- map typed results to stable shell exit classes;
- launch the read-only loopback Observatory service through a parent-owned command path.

All mutating effects occur only after server-side validation, journaling, authority checks, leases, and safe-boundary handling.

## 13. Local transport and secrets

The v0 Mission CLI should communicate with a local parent-owned Control Service through a replaceable local transport such as loopback HTTP, named pipe, or direct in-process adapter.

The design does not freeze the transport, but it requires:

- local-only exposure by default;
- bounded connect/request/response timeouts;
- explicit protocol version handshake;
- service identity/fingerprint where required;
- no silent connection to an arbitrary remote host;
- no credentials or access tokens passed as command-line arguments;
- no real ChatGPT URL or runtime secret printed in normal output;
- transport failure distinct from Mission/Event rejection;
- one canonical server-side journal and reducer regardless of client type.

Remote or multi-user CLI access requires a separate authenticated authorization design and is outside v0.

## 14. Compatibility with existing commands

The Mission CLI must be added without changing the semantics of existing commands such as:

```text
devexec runtime run
devexec closed-loop admit/run/inspect
devexec recover ...
devexec run/continue
```

In particular:

- Mission CLI submission does not secretly call the legacy mutable-target run path;
- Mission CLI does not weaken exact Closed Goal Loop thread/chat/runtime binding;
- `mission inspect` does not reinterpret CGL state without a typed adapter/reducer;
- existing JSON-producing commands remain valid unless deliberately versioned;
- root command dispatch and help remain deterministic;
- machine mode should eventually be consistent across command families, but migration must preserve current operational compatibility.

## 15. v0 implementation boundary

The first Mission CLI should include only:

```text
devexec mission submit
devexec mission followup
devexec mission inspect
devexec mission wait
devexec mission result
devexec mission events
devexec mission episodes
devexec runtime status
```

Required v0 properties:

- `--json` for one-response commands;
- `--jsonl` for bounded event following;
- stdin/file structured input;
- exact Mission identity;
- caller-stable idempotency;
- bounded waits and continuation cursors;
- one canonical MissionResult retrieval;
- shared Control Service read models with the Observatory;
- no interactive prompt in machine mode;
- no direct mutation/execution authority in the client;
- explicit schema, source, freshness, ambiguity, and error fields.

Human aliases, shell completion, rich tables, remote access, plugin discovery, and agent-adapter worker protocols are deferred.

## 16. Candidate later extensions

After v0 is proven, possible extensions include:

- `devexec observatory serve`;
- human-readable tables and color only outside machine mode;
- shell completion generated from command schemas;
- explicit Mission templates;
- artifact upload by immutable digest/reference;
- structured pause/resume/cancel commands implemented as Events;
- policy-approved priority/scheduling Events;
- bounded `devexec agent-adapter` protocol for external Worker/Verifier processes;
- batch read-only queries;
- signed receipts or local service attestation;
- generated language bindings that consume the same schemas;
- MCP/API adapters over the same Control Service.

An external agent-adapter protocol is separate from the operator Mission CLI. It requires explicit Episode assignment, input projection, output validation, cancellation, evidence, and lease contracts before it can perform work.

## 17. Acceptance principles

The CLI is successful when Codex can perform the complete machine workflow without human-oriented parsing:

```text
submit Request
  -> capture exact Mission identity
  -> inspect/wait with bounded calls
  -> attach one exact follow-up Event
  -> observe safe-boundary application
  -> retrieve one canonical verified MissionResult
```

The workflow must remain correct across caller timeout, process restart, duplicate submission, concurrent Missions, provider failure, and internal Episode rotation.

## 18. Non-goals

This design does not authorize or require:

- a second Dev Exec Control Plane;
- direct CLI writes to canonical Mission files;
- direct CLI process/provider/repository authority;
- automatic current/latest/last Mission selection;
- interactive prompts in machine mode;
- raw chain-of-thought or full prompt/response streaming;
- credentials or sensitive payloads in argv;
- treating shell exit success as Mission verification;
- treating a wait timeout as Mission cancellation;
- treating the requesting Codex process as Mission Governor;
- replacing exact Codex Closed Goal Loop behavior;
- unrestricted remote daemon exposure;
- freezing the final transport, frontend, database, internal orchestration topology, or permanent product name.

## 19. Architectural invariant

The CLI must remain replaceable.

A future Codex version, harness, browser UI, MCP client, or native application should be able to use the same Event, Mission, Episode, evidence, and MissionResult contracts without changing canonical Mission semantics.

The durable system owns the work. The CLI only makes that system practical to call, inspect, and resume from automation.
