# Dev Exec — Implementation Goals

This directory is the repository-local implementation-goal list for Dev Exec. These documents describe durable target outcomes and invariants so implementation work can evolve without losing the intended direction.

This list belongs to Dev Exec as a system, not specifically to the ChatGPT MCP transport. It is colocated in this repository because this repository is currently the implementation home of Dev Exec. If Dev Exec is later renamed or split into its own repository, preserve and migrate these Goal authorities.

## Parent architecture

[`../DEVEXEC_SELF_EVOLVING_ARCHITECTURE.md`](../DEVEXEC_SELF_EVOLVING_ARCHITECTURE.md) owns the long-term architecture in which Dev Exec retains durable operational intelligence through Kernel / Reflex Engine / Skills / Forge while reasoning agents remain ephemeral and replaceable. Individual Goal documents under this directory implement bounded slices of that architecture without becoming peer Control Planes.

[`../DEVEXEC_MISSION_INTERFACE_AND_OBSERVABILITY.md`](../DEVEXEC_MISSION_INTERFACE_AND_OBSERVABILITY.md) defines the operator-facing Mission contract shared by the event-ingress and Observatory Goals:

```text
one external Request
  -> one durable Mission
  -> any bounded number of fresh disposable Episodes
  -> one canonical verified MissionResult
```

[`../DEVEXEC_MISSION_CLI.md`](../DEVEXEC_MISSION_CLI.md) defines the non-interactive machine interface through which Codex and other automation can submit, inspect, wait, attach exact Events, and retrieve the same canonical MissionResult without creating a second Control Plane.

## Active / proposed goals

| Goal | Status | Purpose |
| --- | --- | --- |
| [`DEV-LER-001 — Local Ephemeral Reasoning Engine`](DEV-LER-001-LOCAL-EPHEMERAL-REASONING.md) | PROPOSED / GOAL AUTHORITY | Decouple long-running Local Model Missions from small model context windows using fresh ephemeral FIND / SOLVE / VERIFY / GOAL_CHECK episodes and durable Dev Exec state. This is the initial Ephemeral Agents mechanism under the parent architecture. |
| [`DEV-EVT-001 — Operator Event Ingress and Mission Routing`](DEV-EVT-001-OPERATOR-EVENT-INGRESS.md) | PROPOSED / IMPLEMENTATION GOAL | Admit one bounded Task/Consultation as an exact durable Mission, attach new Events to one exact running Mission at a safe fresh-Episode boundary, preserve idempotency/no-replay, and expose one canonical terminal MissionResult. |
| [`DEV-CLI-001 — Codex-Friendly Mission CLI`](DEV-CLI-001-CODEX-MISSION-CLI.md) | PROPOSED / IMPLEMENTATION GOAL | Extend the existing `devexec` root with strict non-interactive JSON/JSONL commands for exact Mission submission, follow-up, inspection, bounded wait, Event/Episode observation, runtime/model status, and canonical result retrieval. |
| [`DEV-OBS-001 — Mission Observatory and Runtime Status Surface`](DEV-OBS-001-MISSION-OBSERVATORY.md) | PROPOSED / IMPLEMENTATION GOAL | Provide a loopback-only read-only view of Missions, fresh Episodes, actual runtime/model state, Event routing, resources, logs, evidence, blockers, and terminal results without becoming a second Control Plane. |
| [`DEV-CTR-001 — Chat Target Discovery / Semantic Resolution`](DEV-CTR-001-CHAT-TARGET-RESOLUTION.md) | PROPOSED / IMPLEMENTATION GOAL | Discover a ChatGPT conversation by human-facing title/Project descriptors, then resolve and freeze one exact canonical conversation identity before sending or starting a run. |

## Relationship of the Ephemeral Mission goals

The four primary Goals are deliberately separated:

```text
DEV-EVT-001
  owns external Request admission, Event journaling/routing, and MissionResult identity

DEV-LER-001
  owns fresh bounded reasoning Episodes and durable reasoning continuity

DEV-CLI-001
  owns the Codex/automation-friendly machine client contract over the same Control Service

DEV-OBS-001
  owns human-readable read-only projection of canonical runtime state and evidence
```

None of them owns all concerns. In particular:

- the Ephemeral Reasoner does not admit or route operator requests;
- the Event ingress does not become an agent or executor;
- the CLI does not reduce Mission state, choose safe boundaries, or acquire execution authority;
- the Observatory does not mutate Mission state or spawn work;
- CLI and Observatory must share server-side read models rather than independently interpret runtime files;
- future execution / independent verification / goal-alignment role topologies remain internal to the Mission and replaceable behind the external contract.

The Mission CLI implements the direction:

```text
Codex -> Dev Exec
```

It remains distinct from the existing exact Closed Goal Loop direction:

```text
Dev Exec -> exact persisted Codex thread
```

## Ordering guidance

A safe implementation order is:

1. define shared Event, MissionSnapshot, EpisodeRecord, MissionResult, CLI error, and read-model schemas;
2. implement `DEV-LER-001` fresh Episode mechanics and durable state transitions;
3. expose one parent-owned Control Service with canonical read models;
4. implement the read-only portions of `DEV-CLI-001` early so Codex/tests can inspect exact state without parsing prose;
5. implement `DEV-EVT-001` new-Mission Task/Consultation admission and exact existing-Mission follow-up;
6. complete `DEV-CLI-001` submit/followup/bounded-wait/result behavior over that ingress;
7. expose the `DEV-OBS-001` loopback Observatory over the same read models to verify context rotation and state truth visually;
8. add pause/resume/cancel request Events and later interactive Observatory controls only through the typed ingress;
9. connect additional model/harness adapters and stronger orchestration without changing the Request/Mission/MissionResult contract.

`DEV-CTR-001` is a supporting control-plane usability goal and may be implemented independently or as an enabling slice when Dev Exec needs to route Local Model/Codex reports back to named ChatGPT conversations without manually supplying URLs.

None of these goals weakens existing Dev Exec safety boundaries. In particular:

- Local Model reasoning does not become Mission/control authority.
- Chat title or Project name never becomes runtime target identity.
- Existing Local Worker, RELAY, recovery/lease, exact target verification, and Closed Goal Loop invariants remain authoritative.
- Rules, Skills, and agent adapters do not self-promote from unverified AI output.
- A follow-up Event is not injected into an already-running agent context.
- A CLI or UI action does not directly mutate state, launch a process, or grant a role/axis.
- Machine-mode CLI commands do not use current/latest/last/fuzzy Mission resolution.
- One Mission commits at most one canonical terminal MissionResult.

## Maintenance rule

When a new Dev Exec implementation objective has architecture-level importance or must remain stable across multiple implementation slices, add it here and give it a dedicated Goal document. Short-lived implementation tasks belong under `docs/tasks/` rather than being promoted into this list.
