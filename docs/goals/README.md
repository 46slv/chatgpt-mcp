# Dev Exec — Implementation Goals

This directory is the repository-local implementation-goal list for Dev Exec. These documents describe durable target outcomes and invariants so implementation work can evolve without losing the intended direction.

This list belongs to Dev Exec as a system, not specifically to the ChatGPT MCP transport. It is colocated in this repository because this repository is currently the implementation home of Dev Exec. If Dev Exec is later renamed or split into its own repository, preserve and migrate these Goal authorities.

## Parent architecture

[`../DEVEXEC_SELF_EVOLVING_ARCHITECTURE.md`](../DEVEXEC_SELF_EVOLVING_ARCHITECTURE.md) owns the long-term architecture in which Dev Exec retains durable operational intelligence through Kernel / Reflex Engine / Skills / Forge while reasoning agents remain ephemeral and replaceable. Individual Goal documents under this directory implement bounded slices of that architecture without becoming peer Control Planes.

## Active / proposed goals

| Goal | Status | Purpose |
| --- | --- | --- |
| [`DEV-LER-001 — Local Ephemeral Reasoning Engine`](DEV-LER-001-LOCAL-EPHEMERAL-REASONING.md) | PROPOSED / GOAL AUTHORITY | Decouple long-running Local Model Missions from small model context windows using fresh ephemeral FIND / SOLVE / VERIFY / GOAL_CHECK episodes and durable Dev Exec state. This is the initial Ephemeral Agents mechanism under the parent architecture. |
| [`DEV-CTR-001 — Chat Target Discovery / Semantic Resolution`](DEV-CTR-001-CHAT-TARGET-RESOLUTION.md) | PROPOSED / IMPLEMENTATION GOAL | Discover a ChatGPT conversation by human-facing title/Project descriptors, then resolve and freeze one exact canonical conversation identity before sending or starting a run. |

## Ordering guidance

`DEV-LER-001` is the primary Local Model operation goal and the first direct implementation component of the replaceable-agent architecture.

`DEV-CTR-001` is a supporting control-plane usability goal and may be implemented independently or as an enabling slice when Dev Exec needs to route Local Model/Codex reports back to named ChatGPT conversations without manually supplying URLs.

Neither goal weakens existing Dev Exec safety boundaries. In particular:

- Local Model reasoning does not become Mission/control authority.
- Chat title or Project name never becomes runtime target identity.
- Existing Local Worker, RELAY, recovery/lease, exact target verification, and Closed Goal Loop invariants remain authoritative.
- Rules, Skills, and agent adapters do not self-promote from unverified AI output.

## Maintenance rule

When a new Dev Exec implementation objective has architecture-level importance or must remain stable across multiple implementation slices, add it here and give it a dedicated Goal document. Short-lived implementation tasks belong under `docs/tasks/` rather than being promoted into this list.
