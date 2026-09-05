# DEV-CLI-001 — Codex-Friendly Mission CLI

Status: PROPOSED / IMPLEMENTATION GOAL  
Scope: non-interactive machine-facing Dev Exec CLI for Codex and automation  
Parent design: [`../DEVEXEC_MISSION_CLI.md`](../DEVEXEC_MISSION_CLI.md)  
Mission interface: [`../DEVEXEC_MISSION_INTERFACE_AND_OBSERVABILITY.md`](../DEVEXEC_MISSION_INTERFACE_AND_OBSERVABILITY.md)

> **Repository scope note:** This Goal belongs to Dev Exec as a system, not specifically to the ChatGPT MCP transport. It is colocated in `46slv/chatgpt-mcp` because this repository is currently the implementation home of Dev Exec.

## Goal

Extend the existing `devexec` root command with a stable machine interface through which Codex or another authorized automation caller can:

1. submit one versioned bounded `TASK` or `CONSULTATION` Request;
2. receive exact `request_id`, `mission_id`, and `event_id` identities;
3. inspect or wait for one exact Mission through bounded non-interactive commands;
4. attach a typed follow-up Event to that exact Mission;
5. observe Event application, Episode rotation, runtime/model state, evidence, and blockers;
6. retrieve exactly one canonical terminal MissionResult.

The CLI must use the same server-side Event ingress, state reducer, Control Service, evidence, and MissionResult contracts as the browser Observatory and other adapters.

## User-facing target

A Codex process should be able to execute a workflow like:

```text
devexec mission submit --request request.json --json
  -> exact mission_id

devexec mission wait --mission <id> --until terminal --timeout-ms <bounded> --json
  -> terminal or bounded non-terminal continuation

devexec mission result --mission <id> --json
  -> one canonical verified MissionResult
```

For a running autonomous Mission:

```text
devexec mission followup --mission <exact-id> --event event.json --json
  -> durable accepted/deferred/applied/duplicate/rejected receipt
```

No human-oriented scraping, interactive selection, browser focus, current/latest Mission inference, or raw conversation continuation is required.

## Direction boundary

This Goal implements:

```text
Codex -> Dev Exec
```

It is distinct from the implemented exact Closed Goal Loop direction:

```text
Dev Exec -> exact persisted Codex thread
```

The Mission CLI does not:

- select or resume a Codex thread;
- replace `closed-loop admit/run/inspect`;
- grant the requesting Codex process Goal or Mission authority;
- certify Codex output as verified;
- create a second scheduler or state store.

## Proposed command set

The exact syntax may receive minor implementation adjustments, but v0 should provide equivalents of:

```text
devexec mission submit --request <file|-> [--wait --timeout-ms <ms>] --json
devexec mission followup --mission <id> --event <file|-> --json
devexec mission inspect --mission <id> --json
devexec mission wait --mission <id> --until <condition> --timeout-ms <ms> --json
devexec mission result --mission <id> --json
devexec mission events --mission <id> [--after <cursor>] [--follow] --jsonl
devexec mission episodes --mission <id> [--after <cursor>] --json
devexec runtime status --json
```

A later `devexec observatory serve` command may launch the read-only loopback Observatory but is not required for the first Mission CLI proof.

## Non-negotiable machine-mode invariants

1. `--json` writes exactly one valid UTF-8 JSON document to stdout.
2. `--jsonl` writes exactly one complete JSON object per stdout line.
3. Diagnostics, warnings, and optional human text go to stderr.
4. Machine stdout contains no banners, ANSI, spinners, progress bars, usage prose, or mixed text.
5. Machine mode never prompts interactively.
6. Missing, malformed, ambiguous, or unsupported input fails with a versioned structured error.
7. Long/structured Request and Event payloads are read from one bounded stdin document or explicit regular file.
8. Machine mode does not require long prompt text, credentials, or sensitive payloads in argv.
9. Unknown schema versions and authority-relevant unknown fields fail closed.
10. Large logs/evidence are returned as bounded summaries and immutable references.
11. Every response includes enough protocol/version/correlation information for a strict client to validate it.
12. A successful shell exit never substitutes for Mission verification or a canonical MissionResult.

## Exact identity invariants

Mutating, waiting, and result commands require exact identities as applicable:

```text
request_id
mission_id
event_id
idempotency_key
expected_state_revision
cursor
result_id
```

The CLI must not silently resolve or accept:

```text
current Mission
latest Mission
most recent run
currently active process
currently visible UI item
browser focus
last Codex session
fuzzy title
mutable default alias
```

If future human convenience resolution is added, it must be a separate explicit read-only resolution step that returns an exact identity before mutation.

## Submission and idempotency

### New Mission

One accepted new-Mission submission returns a durable receipt with at least:

- `request_id`;
- `mission_id`;
- `event_id`;
- caller-stable `idempotency_key`;
- admission status;
- state revision;
- receipt digest;
- canonical observation/result references.

### Existing Mission follow-up

One accepted follow-up requires:

- exact `mission_id`;
- one versioned Event document;
- explicit idempotency identity;
- bounded requested authority;
- payload digest/reference;
- durable receipt.

### Retry behavior

The same payload and same idempotency key return the same durable admission/receipt identity.

A different payload with the same key fails closed.

The CLI or calling harness must not silently generate a fresh key after timeout or unknown delivery. Ambiguous delivery is reconciled through the existing receipt/journal path rather than blind replay.

## Safe-boundary behavior

The CLI may report that a follow-up Event is `ACCEPTED` or `DEFERRED`, but it must not inject that Event into a running Episode.

The Control Plane remains responsible for:

```text
journal Event
  -> preserve current Episode input snapshot
  -> reach terminal or cancel/reconcile
  -> reduce Event into Mission state
  -> launch fresh Episode
  -> mark Event APPLIED
```

The CLI displays receipts and current canonical state; it does not choose the safe boundary.

## Bounded wait contract

`mission wait` and `mission events --follow` must be bounded.

Required semantics:

- explicit or policy-bounded timeout;
- timeout stops observation only;
- timeout does not cancel or fail the Mission;
- response distinguishes condition satisfied, non-terminal timeout, transport failure, terminal blocker, and ambiguity;
- response includes a stable state revision/cursor for later continuation;
- interruption or caller death does not corrupt Mission state;
- cancellation requires a separate typed lifecycle Event;
- no inference from process disappearance, GPU utilization, terminal prose, or agent self-report.

## Canonical result contract

`mission result` returns:

- the one committed canonical MissionResult; or
- a structured `NOT_TERMINAL`, blocked, unavailable, or protocol error response.

Repeated successful retrieval must return the same `result_id` and digest.

Submission receipt, progress Event, Episode output, verifier decision, and MissionResult remain separate protocol types.

## Exit-code classes

The implementation must publish and test a stable numeric mapping that distinguishes at least:

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

Detailed status remains authoritative in JSON. Exit codes are only coarse shell routing signals.

An accepted asynchronous submission is success even though the Mission is still running. A bounded wait timeout is not terminal failure.

## Error contract

All machine-mode failures should return one bounded versioned error envelope containing:

- command;
- status and stable reason code;
- bounded human-readable message;
- retryable flag;
- ambiguous-delivery flag;
- correlation id;
- optional bounded details reference;
- protocol/schema version.

Normal machine stdout must not expose stack traces, credentials, cookies, access tokens, raw prompt bodies, sensitive payloads, or full local paths where logical identities suffice.

## Shared Control Service/read models

The CLI and Observatory must share the same normalized server-side interpretation of:

- Mission status and state revision;
- Event lifecycle and cursors;
- Episode lifecycle and fresh-context evidence;
- configured/selected/loaded/active-Episode model identities;
- runtime/provider health and freshness;
- resources and metric-source attribution;
- tests, evidence, verifier results, and failure fingerprints;
- leases, recovery, and ambiguous pending actions;
- blocker/reason codes;
- terminal MissionResult identity.

The CLI must not reimplement state reduction by reading arbitrary runtime JSON directly.

## Three-axis visibility and authority

The internal orchestration may distinguish:

```text
Task Execution
Goal Control
Mission Governance
```

CLI inspection should preserve parent-assigned `axis` and `role` attribution where available.

The requesting Codex process cannot self-assign:

- `MISSION_GOVERNANCE`;
- Goal completion authority;
- Verifier independence;
- a stronger side-effect class;
- a different model/runtime route;
- permission to mutate canonical state.

The CLI is a transport and observation adapter, not a fourth reasoning axis.

## Local transport boundary

The v0 CLI should use a parent-owned local Control Service through a replaceable local transport.

Required properties:

- loopback/local-only by default;
- bounded connection and request timeouts;
- explicit protocol version handshake;
- no arbitrary remote-host fallback;
- no credentials or tokens in argv;
- transport failure distinct from Event rejection or Mission failure;
- one server-side Event journal/state reducer regardless of client type;
- service restart does not change canonical Mission identity.

Remote/multi-user access is outside v0 and requires separate authentication and authorization design.

## Compatibility requirements

The implementation must preserve existing behavior for:

```text
devexec target ...
devexec goal ...
devexec agent ...
devexec runtime run/metrics/recovery ...
devexec closed-loop admit/run/inspect ...
devexec run/continue
devexec recover ...
```

Required compatibility:

- root dispatch remains deterministic;
- existing exact Closed Goal Loop routing is unchanged;
- Mission submit does not silently enter the legacy mutable-target run path;
- current JSON-producing commands are not broken without explicit versioned migration;
- existing exit behavior is regression tested;
- no real ChatGPT URL, credential, lease, or runtime secret is committed or printed by the new CLI.

## v0 implementation pieces

Candidate mechanical pieces:

```text
Mission CLI dispatcher
strict argv parser
stdin/file bounded JSON reader
Control Service client
protocol/version handshake
machine output writer
error/exit mapper
bounded wait client
JSONL cursor follower
redaction/bounds layer
CLI contract fixtures
```

The client remains thin. Mission/Event validation, persistence, idempotency, reduction, safe-boundary application, and completion stay server-side.

## v0 acceptance

A real bounded test must prove at least:

1. Existing `devexec` commands retain their prior behavior and help routes.
2. `mission submit --request - --json` accepts exactly one bounded versioned stdin document.
3. Machine stdout is one parseable JSON document with no prefix/suffix prose.
4. Missing or malformed input returns a parseable versioned error and stable non-zero exit class.
5. A valid Task submission returns exact `request_id`, `mission_id`, and `event_id`.
6. A valid Consultation submission is distinguishable and remains read-only by default.
7. Repeating the identical submission with the same idempotency key returns the same Mission/receipt identity and does not repeat work.
8. Reusing the key with a different payload fails closed.
9. `mission followup` rejects absent, fuzzy, current, latest, or mismatched Mission identity.
10. A valid follow-up during an active Episode is reported as accepted/deferred without mutating that Episode's input.
11. A later fresh Episode consumes the Event and the CLI can observe its `APPLIED` transition.
12. `mission inspect` is read-only, bounded, retryable, and shows state revision, active Episode, model attribution, blocker, and result reference.
13. `mission wait` returns when its exact condition is satisfied.
14. A bounded wait timeout returns a non-terminal timeout response and leaves the Mission running.
15. Caller interruption and subsequent retry resume from exact Mission state without replaying work.
16. `mission events --after <cursor> --jsonl` resumes in order without cross-Mission records or unrequested duplicates.
17. Every JSONL line is independently parseable and typed; heartbeats are distinguishable.
18. `mission episodes` exposes fresh-context lifecycle evidence without raw conversations.
19. `runtime status` distinguishes configured, selected, loaded, active-Episode, and merely available models with source/freshness.
20. `mission result` returns `NOT_TERMINAL` before completion and the same canonical result identity after completion.
21. A Mission terminal `BLOCKED`, `NEEDS_HUMAN`, `CANCELLED`, `FAILED`, and `COMPLETE` are structurally distinguishable.
22. Exit classes distinguish invalid input, blocked, needs-human, terminal failure/cancel, service unavailable, wait timeout, ambiguity, and protocol mismatch.
23. Diagnostics go to stderr and do not corrupt stdout JSON/JSONL.
24. Long prompt/event bodies, credentials, cookies, tokens, and sensitive payloads do not appear in argv or normal output.
25. CLI and Observatory projections agree for the same Mission state revision.
26. Multiple concurrent Missions do not cross-contaminate identity, Events, Episodes, logs, results, or cursors.
27. Control Service restart preserves exact Mission/Event/result identities and duplicate protection.
28. An ambiguous submission or pending side effect is reported explicitly and is not blindly retried.
29. A Codex caller can complete `submit -> inspect/wait -> followup -> result` using only structured outputs.
30. Existing Local Worker, Event/recovery/lease, run-ledger, and Closed Goal Loop regression suites remain intact.

## Future extensions

After v0, possible additions include:

- `mission pause/resume/cancel` as typed Event commands;
- `observatory serve`;
- shell completion generated from schemas;
- human-readable tables outside machine mode;
- Mission templates;
- artifact references/uploads;
- policy-approved priority/scheduling Events;
- generated client libraries;
- MCP/API adapters over the same Control Service;
- a separate bounded external Agent Adapter CLI for assigned Worker/Verifier Episodes.

An Agent Adapter protocol is not implied by this Goal. It requires explicit Episode assignment, context projection, output schema, cancellation, evidence, and lease contracts.

## Failure and stop conditions

Fail closed when:

- protocol/schema versions are unsupported;
- exact Mission identity is absent or mismatched;
- idempotency payload/key conflict occurs;
- authority exceeds caller/Mission policy;
- Control Service identity or transport cannot be trusted;
- output bounds or redaction cannot be maintained;
- state is too stale to satisfy the requested condition;
- pending/ambiguous side effects cannot be reconciled;
- terminal MissionResult identities conflict;
- a command would require direct client-side persistence, process, provider, or repository authority.

## Non-goals

This Goal does not authorize or require:

- a second Control Plane or state reducer;
- direct CLI writes to Mission files;
- direct CLI process/provider/repository mutation;
- current/latest/last Mission selection in machine mode;
- interactive prompts in machine mode;
- raw chain-of-thought or full provider traffic;
- sensitive Request content in argv;
- treating CLI exit 0 as verified Mission completion;
- treating wait timeout as cancellation;
- allowing Codex to self-assign Mission Governor or Verifier authority;
- replacing exact Codex Closed Goal Loop commands;
- unrestricted remote service exposure;
- freezing the final local transport or internal agent topology.

## Success condition

Codex can use one stable non-interactive CLI to submit and continue work with Dev Exec, observe exact durable progress across disposable internal agents, and retrieve one verified canonical result without human-oriented parsing, hidden defaults, context injection, or authority bypass.
