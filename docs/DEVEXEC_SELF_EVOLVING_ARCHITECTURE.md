# Dev Exec — Self-Evolving Operational Intelligence Architecture

Status: PROPOSED / ARCHITECTURE AUTHORITY  
Last updated: 2026-09-03 JST  
Scope: Dev Exec control plane, local autonomous operation, replaceable reasoning runtimes, operational knowledge promotion

> **Repository scope note:** This architecture belongs to **Dev Exec as a system**, not specifically to the ChatGPT MCP transport. It is colocated in `46slv/chatgpt-mcp` because this repository is currently the implementation home of Dev Exec. A future repository split or rename must preserve these ownership and authority boundaries.

> **Implementation status note:** This document defines the target architecture. Existing components such as the direct ChatGPT-to-PowerShell loop, durable run state, Local Model `RELAY` / `AGENT`, recovery and leases, exact target binding, and Codex Closed Goal Loop provide parts of the foundation. The complete architecture below is not yet implemented.

## 0. Executive summary

Dev Exec should not depend on one permanently capable agent. Models, quantizations, harnesses, context windows, and provider runtimes will change. The durable system must therefore own the Mission, evidence, authority, operational memory, Skills, and decision policy, while agents remain short-lived and replaceable reasoning components.

The target is:

> **Agents may change; acquired operational capability must remain.**

Dev Exec should gradually convert repeated AI judgment into cheaper, smaller, and more deterministic machinery:

```text
unknown situation
  -> bounded agent / ChatGPT judgment
  -> structured Decision Episode
  -> repeated verified pattern
  -> declarative JSON rule
  -> shadow evaluation and counterexample tests
  -> active Reflex rule
  -> small typed function
  -> stable Core guard or Skill
```

This is not online model training and not unrestricted recursive self-modification. It is **operational intelligence distillation**: verified recurring decisions are moved out of model context and into inspectable policy, tests, and code.

The proposed system has five primary layers:

```text
1. Kernel            durable state, events, identity, leases, journal, recovery
2. Reflex Engine     deterministic JSON rules, state machines, abstention
3. Skills            typed actions over GitHub, network, files, Codex, Obsidian, machine state
4. Forge             episode -> rule -> function -> guarded promotion
5. Ephemeral Agents  interchangeable FIND / SOLVE / VERIFY / GOAL_CHECK reasoning runtimes
```

Cross-cutting boundaries apply to every layer:

- evidence and provenance;
- authority and side-effect classification;
- idempotency and ambiguous-delivery handling;
- isolation, rollback, and bounded execution;
- observability and human-readable reporting.

## 1. Problem statement

Improving the intelligence of a local model itself is not a reliable Dev Exec strategy. A better model may arrive later, but the current system still needs to become more useful, reliable, and autonomous now.

The recurring waste is not only token consumption. It is repeated rediscovery:

- whether a GitHub failure should be retried, inspected, or escalated;
- whether a local model fits in VRAM, can be CPU-offloaded, or should be rejected;
- whether a Codex report belongs to the expected task/thread/chat binding;
- whether a network failure is transient, local, DNS-related, route-related, or an authority boundary;
- whether a tool failure represents no progress, changed evidence, or an ambiguous side effect;
- whether a maintenance action is safe to perform automatically.

If every run asks an agent to reconstruct these decisions from prose, Dev Exec remains model-dependent. The target is to retain only genuinely novel judgment in agents and remove stable recurring judgment from them.

## 2. Core thesis

### 2.1 The Control Plane owns continuity

Dev Exec, not any model session, owns:

- Mission / Goal / Task / Run identity;
- current verified state;
- authority and side-effect limits;
- exact ChatGPT, Codex, repository, runtime, and worktree bindings;
- pending and in-flight action identity;
- dedupe, retry, reconciliation, and no-replay boundaries;
- evidence, verifier outcomes, failure fingerprints, and checkpoints;
- rule, Skill, and agent-adapter registries;
- promotion, rollback, suspension, and retirement history.

### 2.2 Agents own temporary reasoning only

An agent may:

- interpret a bounded unknown situation;
- propose a decision or action;
- implement one bounded Goal through an approved executor;
- produce a structured result;
- request more bounded context;
- abstain or escalate.

An agent must not silently become owner of Mission state, routing identity, permissions, evidence truth, or promotion authority.

### 2.3 Repeated judgment should disappear from prompts

Once a decision has become stable enough to express as typed inputs, explicit predicates, and a bounded output, it should stop consuming agent context. The preferred progression is:

```text
prompt instruction
  -> structured policy data
  -> deterministic evaluator
  -> typed function / mechanical guard
```

### 2.4 Uncertainty is a valid deterministic output

The Reflex Engine is not required to decide every case. `ABSTAIN`, `ESCALATE`, `INSPECT`, and `NEEDS_HUMAN` are first-class outcomes. A small intelligence that knows its boundary is safer than a large rule set that guesses.

## 3. Current-to-target transition

The historical minimal path remains important:

```text
ChatGPT instruction
  -> Dev Exec directive parser
  -> bounded local PowerShell execution
  -> receipt / stdout / stderr / exit status
  -> ChatGPT
```

This remains a useful direct-control and recovery path. It should not, however, remain the only way Dev Exec begins work.

The target operating shape is event-driven:

```text
Windows service / daemon / scheduled bounded runner
  -> Event Spine
  -> Reflex Engine
       known case    -> Skill / deterministic action
       unknown case  -> Ephemeral Agent
       high boundary -> ChatGPT / Human
  -> Verifier / Evidence
  -> durable state transition
  -> optional Obsidian report projection
```

The daemon is not one infinite agent session. It is a durable event processor that launches bounded, disposable work episodes.

## 4. Top-level architecture

```text
External and local events
  GitHub / Codex / filesystem / process / network / timer / operator
                         │
                         ▼
┌──────────────────────────────────────────────────────────────┐
│ Dev Exec Kernel                                              │
│ identity · event journal · leases · recovery · checkpoints   │
└──────────────────────────────┬───────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ Reflex Engine                                                │
│ typed snapshot · rule evaluation · conflict check · abstain  │
└───────────────┬──────────────────────────────┬───────────────┘
                │ known                        │ unknown/boundary
                ▼                              ▼
┌─────────────────────────────┐   ┌────────────────────────────┐
│ Skills / Action Broker      │   │ Ephemeral Reasoning       │
│ typed, bounded side effects │   │ Local / Codex / ChatGPT   │
└───────────────┬─────────────┘   └──────────────┬─────────────┘
                └───────────────┬────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────┐
│ Verifier / Evidence / Outcome                                │
└──────────────────────────────┬───────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ Forge                                                        │
│ episodes · pattern mining · rule drafts · fixtures · shadow  │
│ promotion · compilation · drift monitoring · retirement      │
└──────────────────────────────┬───────────────────────────────┘
                               ▼
                  stronger Reflexes and Skills
```

## 5. Kernel

The Kernel must stay small, deterministic, and independent of model choice.

### 5.1 Responsibilities

- append-only event and action journal;
- canonical Mission / Goal / Run state reduction;
- immutable correlation and binding identities;
- resource leases for provider, device, port, repository, worktree, and external target;
- atomic receipts before and after side effects;
- crash recovery and ambiguous-state reconciliation;
- cancellation, timeout, and kill-switch handling;
- registry loading with schema/version validation;
- dispatch to Reflex, Skill, Agent Adapter, or Supervisor;
- state snapshots and evidence references by hash.

### 5.2 Kernel exclusions

The Kernel should not contain:

- provider-specific reasoning prompts;
- large domain knowledge documents;
- agent conversation transcripts;
- mutable external credentials;
- broad shell authority disguised as a helper;
- application-specific workflow logic that belongs in a Skill or rule.

## 6. Event Spine

All autonomous behavior should begin from a typed event rather than hidden polling logic or model initiative.

Candidate event families:

```text
codex.turn.completed
codex.supervisor.requested
chatgpt.response.received
github.pr.updated
github.workflow.failed
github.workflow.completed
network.endpoint.unreachable
machine.memory.pressure
model.runtime.unhealthy
filesystem.watched_change
devexec.skill.failed
devexec.rule.conflict
devexec.unknown_decision
devexec.maintenance.due
devexec.report.due
operator.command.received
```

Minimal event envelope:

```json
{
  "protocol": "devexec.event",
  "schema_version": 1,
  "event_id": "uuid",
  "kind": "github.workflow.failed",
  "occurred_at": "2026-09-03T15:00:00+09:00",
  "source": {
    "adapter": "github",
    "binding_id": "sha256:..."
  },
  "subject": {
    "mission_id": "...",
    "task_id": "..."
  },
  "correlation_id": "...",
  "payload_ref": {
    "sha256": "sha256:...",
    "location": "runtime-owned-reference"
  },
  "side_effect_class": "none"
}
```

Large payloads should remain outside the event record and be referenced by immutable hash/location. Sensitive data must be redacted before persistence.

## 7. Reflex Engine — Minimal Intelligence

The Reflex Engine is the intended home of the concept "agentではなく、無数の指定された判断によって振る舞うミニマルインテリジェンス".

It is not a general planner. It is a deterministic policy evaluator over typed state.

### 7.1 Evaluation contract

```text
Event + typed current snapshot + active policy set
  -> one of:
       DECIDE(action contract)
       REQUEST_INSPECTION
       ABSTAIN
       ESCALATE(agent class)
       NEEDS_CHATGPT
       NEEDS_HUMAN
       STOP
```

### 7.2 Required semantics

- Unknown input fields do not silently coerce into matches.
- A rule cannot grant authority that the caller does not already possess.
- Rules produce an action proposal; the Action Broker revalidates authority and current state immediately before execution.
- Conflicting equal-precedence rules cause `ABSTAIN`, not arbitrary first-match selection.
- Every decision records the exact rule/version and input snapshot hash.
- Rules may be disabled instantly without deleting their history.
- Evaluation is deterministic for identical inputs and active registry versions.

### 7.3 Example rule

```json
{
  "protocol": "devexec.reflex-rule",
  "schema_version": 1,
  "rule_id": "local-model-placement.cpu-offload.v1",
  "status": "shadow",
  "domain": "machine.model-placement",
  "priority": 100,
  "when": {
    "all": [
      { "field": "model.required_vram_gb", "op": ">", "value_from": "machine.free_vram_gb" },
      { "field": "machine.free_ram_gb", "op": ">=", "value_from": "model.required_cpu_offload_ram_gb" },
      { "field": "task.latency_class", "op": "in", "value": ["background", "maintenance"] }
    ]
  },
  "deny_if": [
    { "field": "machine.memory_pressure", "op": "==", "value": "critical" }
  ],
  "decision": {
    "action": "model.start_with_cpu_offload",
    "parameters": {
      "placement": "hybrid"
    }
  },
  "required_evidence": [
    "machine.memory.snapshot",
    "model.runtime.spec"
  ],
  "provenance": {
    "episode_ids": ["..."],
    "fixture_set": "model-placement-v1",
    "approved_commit": "..."
  }
}
```

Production schema details may differ, but provenance, status, authority limits, and deterministic testability are mandatory.

## 8. Skills and Action Broker

A Skill converts an approved decision into one bounded capability. It is the durable "weapon" that remains when the agent changes.

Candidate Skills:

```text
machine.measure_memory
model.inspect_runtime
model.choose_placement
github.inspect_workflow_failure
github.create_branch
github.update_file
github.prepare_pull_request
network.capture_route_state
network.test_endpoint
codex.inspect_exact_thread
codex.queue_exact_prompt
obsidian.render_daily_report
filesystem.atomic_write
process.run_bounded
```

Each Skill manifest should declare:

- typed input and output schemas;
- preconditions and invariants;
- side-effect class;
- required authority;
- allowed filesystem paths, hosts, repositories, or account scopes;
- timeout, retry, and idempotency behavior;
- expected evidence and verification command;
- rollback or compensation behavior where possible;
- version, implementation digest, and compatibility contract.

### 8.1 Side-effect classes

Suggested classes:

```text
READ_ONLY
LOCAL_REVERSIBLE
REPO_REVERSIBLE
EXTERNAL_REVERSIBLE
IRREVERSIBLE_OR_HIGH_AUTHORITY
```

Read-only observation may be broadly automated. Repository mutation should normally occur in an isolated branch/worktree with deterministic verification. External publication, messaging, billing, credential, permission, deletion, and other high-authority changes remain explicitly gated.

### 8.2 Direct PowerShell

Direct PowerShell remains a valid low-level executor and operator recovery surface. It should not become the default autonomous abstraction. Repeated autonomous behavior should migrate toward typed Skills so inputs, authority, idempotency, and evidence are mechanically visible.

## 9. Forge — Operational Intelligence Distillation

Forge is the system that turns verified experience into durable capability.

### 9.1 Input

Forge consumes structured Decision Episodes and outcomes, not raw chain-of-thought transcripts.

A Decision Episode should capture:

```json
{
  "protocol": "devexec.decision-episode",
  "schema_version": 1,
  "decision_id": "uuid",
  "domain": "github.ci-recovery",
  "event_ref": "event-id",
  "state_snapshot_sha256": "sha256:...",
  "verified_facts": [
    { "key": "failure_fingerprint", "value": "...", "evidence_ref": "..." }
  ],
  "candidate_actions": ["inspect", "retry", "escalate"],
  "selected_action": "inspect",
  "decision_source": {
    "type": "chatgpt",
    "adapter_version": "..."
  },
  "reason_codes": ["SAME_FAILURE_WITHOUT_EVIDENCE_DELTA"],
  "authority_class": "REPO_REVERSIBLE",
  "required_verification": ["workflow_state_changed"],
  "outcome": {
    "status": "verified_success",
    "evidence_refs": ["..."],
    "observed_at": "..."
  }
}
```

Do not make hidden model reasoning a dependency. Store bounded facts, candidates, selected action, reason codes, evidence requirements, and verified outcome.

### 9.2 Promotion lifecycle

```text
OBSERVATION
  -> EPISODE_RECORDED
  -> PATTERN_CANDIDATE
  -> RULE_DRAFT
  -> SHADOW
  -> VERIFIED_RULE
  -> ACTIVE_RULE
  -> COMPILED_FUNCTION
  -> CORE_GUARD / STABLE_SKILL
```

Every stage may also transition to:

```text
SUSPENDED
REJECTED
RETIRED
SUPERSEDED
```

### 9.3 Promotion gates

No single successful episode should become a general rule. Promotion should require, according to risk:

- multiple independent verified episodes;
- stable typed input features;
- at least one counterexample or deny-case fixture;
- replay against historical fixtures;
- independent Verifier acceptance;
- shadow-mode agreement against current decisions;
- no authority expansion;
- an explicit rollback path;
- drift monitoring criteria;
- repository review or stronger approval for higher-risk classes.

A reasonable initial default for low-risk rules is at least three verified matching episodes across more than one run plus a negative fixture. This is a default heuristic, not universal proof. Higher-risk policy requires stronger evidence and may never be promoted to unattended execution.

### 9.4 Shadow mode

A rule in `SHADOW` evaluates real events but cannot execute. Dev Exec records:

- whether it matched;
- what it would have decided;
- what the actual agent/ChatGPT/human decision was;
- whether the eventual outcome supports or contradicts the rule.

This produces evidence without granting authority prematurely.

### 9.5 Compilation

Once a rule is stable, latency-sensitive, or safety-critical, it may be compiled into a typed function or guard:

```text
decideModelPlacement(machineSnapshot, modelSpec, taskClass)
decideCIRetry(failureFingerprint, progressDelta, retryHistory)
validateCodexReturn(binding, sourceTurn, report, prompt)
```

The compiled implementation must remain traceable to the rule/version, preserve fixtures, and produce the same decision for the same supported input domain.

## 10. Ephemeral Agents

Agents are replaceable reasoning runtimes selected through a narrow adapter contract.

Potential runtimes include:

- current local Qwen/FreeToken path;
- future better-quantized local models;
- Codex;
- Pi or another Worker Harness;
- ChatGPT as sparse Supervisor/Critic;
- future providers not yet known.

### 10.1 Agent Adapter contract

An adapter registry should record:

- exact runtime/executable and digest;
- provider/model/version/quantization identity;
- supported context and tool protocol;
- capability classes;
- cost, latency, and resource requirements;
- allowed side-effect/risk ceiling;
- health and contract-test status;
- cancellation and timeout behavior;
- output schema versions;
- whether session state is disposable or resumable.

### 10.2 Ownership boundary

```text
Dev Exec owns Mission and authority.
Harness owns bounded episode mechanics.
Agent owns temporary reasoning.
Executor owns actual bounded mutation.
Verifier owns acceptance evidence.
```

Changing the agent must not require rewriting the Mission schema, rule registry, Skill contracts, or canonical state.

### 10.3 Relationship to DEV-LER-001

[`DEV-LER-001 — Local Ephemeral Reasoning Engine`](goals/DEV-LER-001-LOCAL-EPHEMERAL-REASONING.md) is the initial mechanism for disposable reasoning episodes. Its `FIND -> SOLVE -> VERIFY -> GOAL_CHECK` loop is a component of this larger architecture, not the owner of the Control Plane.

## 11. Self-maintenance loop

Dev Exec should eventually maintain and extend itself, but only through the same bounded authority it applies to other repositories.

Target flow:

```text
devexec.maintenance.due
  -> inspect current verified state
  -> Reflex handles known maintenance
  -> fresh FIND identifies one bounded improvement
  -> fresh SOLVE implements in dedicated worktree/branch
  -> deterministic tests and evidence
  -> fresh VERIFY
  -> GOAL_CHECK
  -> commit / PR / staged artifact
  -> promote only under policy
  -> record Decision Episodes and capability delta
```

Required constraints:

- no direct unverified mutation of the running executable;
- no direct autonomous write to protected/default branch;
- no replacement of an in-use agent adapter without contract tests and rollback;
- no rule or Skill self-promotion based only on its own generated evidence;
- parent-owned lease and update lock;
- known-good version and one-command rollback;
- separate proposer and verifier contexts for non-trivial changes;
- restart/resume from durable state, not agent conversation;
- bounded maintenance windows and resource budgets;
- explicit stop on repeated no-progress fingerprints.

The system may improve its armament, but it must do so through isolated, inspectable, reversible promotion.

## 12. Codex and ChatGPT integration

The existing exact Codex Closed Goal Loop is a high-value event path and should be reused rather than duplicated.

```text
codex.turn.completed
  -> exact source-turn / task / thread / runtime validation
  -> bounded report
  -> Local Model RELAY hash approval
  -> exact task-bound ChatGPT conversation
  -> correlated ChatGPT decision/prompt
  -> Local Model RELAY return approval
  -> exact original Codex thread queue
```

In the target architecture:

- this path becomes one adapter and event family under the Kernel;
- ChatGPT is used for novel/high-level judgment and semantic supervision, not every routine step;
- repeated ChatGPT decisions may generate Decision Episodes for Forge;
- routing, correlation, dedupe, and ambiguous-delivery safety remain parent-owned;
- the Local Model `RELAY` role remains separate from reasoning and execution roles.

## 13. Internet and GitHub operation

Internet information operation should be decomposed into typed capabilities rather than unrestricted browser or shell agency.

Suggested split:

```text
observe.fetch
observe.search
observe.parse
observe.compare
repo.read
repo.branch
repo.commit
repo.pr.prepare
external.write.prepare
external.write.execute
```

Read operations can usually run under lower authority with domain, size, timeout, and provenance limits. External writes must identify:

- exact service/account/resource;
- intended mutation;
- idempotency key;
- reversible/irreversible class;
- verification method;
- approval source;
- ambiguity handling.

No agent should infer that access to a browser, GitHub token, or authenticated session grants permission to publish, delete, change billing, alter credentials, or modify authority.

## 14. Obsidian reporting projection

Obsidian is suitable for recent reports because a Vault is ordinary Markdown and can be written locally without making Obsidian a Control Plane dependency.

Recommended ownership:

```text
GitHub / runtime state = canonical design, code, policy, evidence references
Obsidian              = human-readable projection of recent activity
```

Suggested Vault layout:

```text
Dev Exec/
  Daily/
    2026-09-03.md
  Decisions/
    GitHub CI Recovery.md
    Local Model Placement.md
  Incidents/
    2026-09-03-network-github.md
  Capabilities/
    Reflex Rules.md
    Skills.md
    Agent Adapters.md
  Reports/
    Weekly/
```

The Vault root should be runtime configuration outside tracked source. Dev Exec should write atomically and deduplicate by `event_id` / `decision_id`.

A daily note entry should be rendered from structured records and include only bounded human-readable material:

```markdown
## 15:10 — Codex task completed

- Mission: ...
- Task/thread binding: verified
- Result: COMPLETE
- Evidence: ...
- Capability delta: none
- Follow-up: ...
<!-- devexec:event_id=... -->
```

Required rules:

- do not store secrets, credentials, raw browser state, or unnecessary logs;
- Obsidian write failure must not corrupt canonical Mission state;
- rendering is reproducible from the structured ledger;
- record a `devexec.note.rendered` receipt after successful write;
- edits made manually in Obsidian do not silently rewrite canonical runtime state;
- future bidirectional actions require a separate explicit command schema and authority boundary.

## 15. Durable storage model

Candidate runtime-owned stores:

```text
state/
  missions/
  runs/
  snapshots/
events/
  events.jsonl
decisions/
  episodes/
  outcomes/
registry/
  rules/
  skills/
  agents/
  schemas/
forge/
  candidates/
  fixtures/
  shadow-results/
  promotions/
reports/
  render-receipts/
```

Repository-tracked material should contain stable schemas, rules, fixtures, Skill implementations, architecture, and promotion history appropriate for code review. Machine-specific state, real URLs, credentials, live leases, and large/sensitive evidence remain outside Git.

## 16. Example flows

### 16.1 Local model placement

```text
machine.memory.snapshot
  -> Reflex checks active placement rules
  -> known safe hybrid placement
  -> model.start_with_cpu_offload Skill
  -> health probe and memory evidence
  -> outcome recorded
```

Unknown model metadata or critical memory pressure causes abstention/escalation rather than guessed startup.

### 16.2 GitHub CI failure

```text
github.workflow.failed
  -> normalize failure fingerprint
  -> compare previous attempts and evidence delta
  -> same fingerprint + no progress
       => inspect/change approach, not blind retry
  -> Skill gathers bounded logs/status
  -> agent only if diagnosis remains unknown
```

The resulting decision and outcome become Forge input. A recurring stable recovery pattern may later become a rule or Skill.

### 16.3 Codex completion

```text
codex.turn.completed
  -> current exact Closed Goal Loop adapter
  -> ChatGPT semantic decision
  -> correlated continuation or COMPLETE
  -> Obsidian report projection
  -> repeated supervisory pattern optionally recorded as Decision Episode
```

### 16.4 Agent replacement

```text
new agent/runtime candidate
  -> adapter manifest
  -> contract fixtures
  -> read-only probe
  -> bounded-write probe
  -> cancellation/recovery probe
  -> shadow routing comparison
  -> registry promotion
  -> old adapter remains rollback target
```

No Mission schema or canonical state migration should be required merely to change the worker model.

## 17. Candidate implementation sequence

### Phase 0 — Architecture and schemas

- preserve this document as architecture authority;
- define Event, Decision Episode, Reflex Rule, Skill Manifest, Agent Manifest, and Promotion Receipt schemas;
- define side-effect and authority classes;
- add deterministic schema tests.

### Phase 1 — Event Spine and Obsidian report sink

- normalize current Codex/ChatGPT/Local Worker events;
- create append-only event journal and reducer boundary;
- implement one-way atomic Obsidian daily report rendering;
- prove dedupe and restart behavior.

### Phase 2 — Decision Episode Ledger

- capture bounded structured decisions from ChatGPT, local agents, and deterministic routes;
- attach verified outcomes later without rewriting original decisions;
- prohibit raw reasoning transcripts as canonical input;
- implement query/aggregation by domain and failure fingerprint.

### Phase 3 — Reflex Engine in shadow mode

- implement deterministic rule evaluator;
- begin with one low-risk domain such as local model placement or CI retry classification;
- compare shadow decisions with actual decisions;
- record conflicts, abstentions, and drift.

### Phase 4 — Forge promotion pipeline

- generate rule candidates from repeated episodes;
- require independent fixtures and verifier acceptance;
- promote through repository branch/PR or equivalent guarded path;
- implement suspend/rollback/retire.

### Phase 5 — Agent Adapter Registry

- formalize local Qwen/FreeToken, Codex, and future harness adapters;
- contract-test context, tool calls, cancellation, output schemas, and resource use;
- route by capability/risk/resource policy rather than hard-coded model identity.

### Phase 6 — Bounded self-maintenance

- schedule bounded maintenance events;
- use `DEV-LER-001` fresh roles in isolated worktrees;
- allow creation and repair of rules, Skills, adapters, tests, and docs;
- keep promotion and runtime replacement separately gated.

## 18. Success metrics

The architecture succeeds when measurable work moves from repeated model reasoning into verified machinery without increasing unsafe autonomy.

Candidate metrics:

- percentage of events resolved deterministically;
- agent/ChatGPT calls avoided per domain;
- context tokens per completed Mission;
- repeated-decision rate before and after promotion;
- Reflex agreement and abstention rates;
- false-positive / unsafe-action rate;
- rollback and recovery success;
- time from repeated pattern to verified rule;
- Skill reuse across different agents;
- successful agent replacement without Mission migration;
- Obsidian report completeness and dedupe rate;
- number of stable prompt instructions removed because they became policy/code.

A rising rule count alone is not success. Rules must reduce rediscovery while preserving correctness, authority, and maintainability.

## 19. Non-goals

This architecture does not target:

- training or fine-tuning the local model online;
- preserving raw chain-of-thought as system memory;
- one immortal autonomous agent session;
- unrestricted recursive self-rewriting;
- replacing deterministic verification with agent confidence;
- automatic publication, deletion, billing, credential, permission, or authority changes;
- converting every decision into a rule;
- making Obsidian canonical Mission state;
- duplicating the existing Codex Closed Goal Loop;
- depending permanently on one model, provider, quantization, or harness.

## 20. Architectural invariants

1. Dev Exec remains the canonical Control Plane.
2. Agent and harness implementations remain replaceable.
3. Mission duration is independent of one model context.
4. Repeated verified judgment should move toward deterministic policy/code.
5. One observation is never sufficient for general promotion.
6. AI-generated evidence alone cannot self-authorize promotion.
7. Rules cannot expand authority.
8. Actual side effects pass through a typed, revalidated execution boundary.
9. Ambiguous external or child-process delivery is reconciled, not blindly repeated.
10. Self-maintenance occurs in isolation with verification and rollback.
11. Obsidian is a derived reporting surface, not canonical authority.
12. Unknown, conflicting, or drifted cases abstain or escalate.
13. Stable capability survives replacement of the agent that helped create it.

## 21. Relationship to existing authority

Operational behavior remains governed first by the current runbook, exact bindings, implemented code/tests, and live runtime evidence.

Relevant documents:

- [`DEVEXEC_CLOSED_LOOP_RUNBOOK.md`](DEVEXEC_CLOSED_LOOP_RUNBOOK.md) — current exact Codex/ChatGPT completion-driven operation.
- [`DEVEXEC_TASK_BOUND_CHAT_TARGET.md`](DEVEXEC_TASK_BOUND_CHAT_TARGET.md) — immutable ChatGPT target authority.
- [`DEVEXEC_CONCURRENT_RELAY_SAFETY.md`](DEVEXEC_CONCURRENT_RELAY_SAFETY.md) — concurrency, correlation, and ambiguous-delivery safety.
- [`DEVEXEC_LOCAL_RUN_LEDGER.md`](DEVEXEC_LOCAL_RUN_LEDGER.md) — current local run persistence concepts.
- [`goals/DEV-LER-001-LOCAL-EPHEMERAL-REASONING.md`](goals/DEV-LER-001-LOCAL-EPHEMERAL-REASONING.md) — fresh local reasoning episodes and durable state boundary.
- [`goals/README.md`](goals/README.md) — Dev Exec implementation Goal index.

This document owns the long-term architectural direction: **Kernel / Reflex / Skills / Forge / Ephemeral Agents**, with durable operational intelligence retained outside replaceable models.
