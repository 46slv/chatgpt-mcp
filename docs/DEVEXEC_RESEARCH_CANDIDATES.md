# DevExec Research Candidates

Potential technologies, harnesses, patterns, and external projects worth revisiting for DevExec.

This file is a research/candidate ledger, not an implementation commitment. Before adoption, re-read the upstream project and compare it against the current DevExec architecture and authority boundaries.

## Candidates

### Headlong — persistent agent microharness

- Status: candidate / research
- Added: 2026-08-30
- Upstream: https://github.com/laude-institute/headlong
- License: Apache-2.0
- Integration intent: study and selectively adopt patterns; do not replace DevExec wholesale.

Why it is interesting for DevExec:

- Persistent agency: an agent can continue deciding what to think about or do without requiring each run to be initiated by a new user turn.
- Self-scheduled wake/backoff: reactive work can run immediately while idle cognition backs off automatically instead of using a fixed polling loop.
- Append-only trajectory DAG: thoughts/actions/results can remain inspectable and support fork/merge rather than being overwritten by compacted session state.
- Tiered memory / recap: recent history stays detailed while older history is summarized at progressively coarser levels, with raw trajectory retained as source of truth.
- Self-improvement by fork -> test -> merge: useful reference for bounded DevExec self-development lanes.
- Thinker/subscription model: potentially useful for separating responder, planner, retrieval, maintenance, and supervisor responsibilities.
- Docker-first execution boundary: useful reference for containing autonomous background cognition and generated shell work.

Preferred architectural relationship if adopted:

```text
Persistent Supervisor / cognition layer
  -> decides whether a new goal/run is warranted
  -> requests a bounded DevExec run

DevExec
  -> remains execution authority
  -> enforces run scope, safety gates, machine boundaries, Git/test/verification
  -> returns durable evidence/results

Supervisor
  -> consumes the result as evidence
  -> updates trajectory/memory
  -> decides the next action or goes idle
```

Do not copy these Headlong choices blindly:

- Do not replace DevExec with Headlong.
- Do not make Bash the sole authority/tool boundary for DevExec.
- Do not give an autonomous cognition loop unrestricted host execution.
- Do not allow upstream auto-update to mutate production DevExec behavior; pin/fork any adopted dependency or code.
- Keep decision/cognition separate from typed execution authority.

Components to inspect first when this candidate is revisited:

1. `bin/traj` — append-only trajectory + fork/merge model.
2. `bin/context` and `bin/recap` — bounded context projection and tiered memory.
3. `thinkers/monolith/step` — persistent wake loop and exponential backoff.
4. `thinkers/*/subscriptions.jsonl` — event/subscription routing model.
5. `bin/shellm` / Docker broker — sandbox and execution-boundary ideas.
6. Self-improvement workflow — fork, test, merge/discard lifecycle.

Possible DevExec use cases:

- Start a new RUN after a previous RUN completes when a verified next step exists.
- Revisit blocked/unfinished work when new evidence arrives.
- Maintain long-running project execution memory without treating summaries as source of truth.
- Periodically inspect DevExec's own failures and propose bounded self-improvement runs.
- Use cheap/local models for idle cognition and escalate difficult decisions to stronger models while keeping execution authority in DevExec.

Re-evaluation gate before implementation:

- Fresh-read Headlong upstream and current open issues/security posture.
- Compare with current DevExec source of truth and existing planner/runtime boundaries.
- Prototype only inside an isolated branch/container.
- Measure token/cost/runaway behavior and idle-loop usefulness.
- Require explicit typed handoff from cognition layer into DevExec execution.
