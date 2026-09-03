# DEV-LER-001 — Local Ephemeral Reasoning Engine

Status: PROPOSED / GOAL AUTHORITY  
Scope: Dev Exec local-model operation  
Parent architecture: [`../DEVEXEC_SELF_EVOLVING_ARCHITECTURE.md`](../DEVEXEC_SELF_EVOLVING_ARCHITECTURE.md)

> **Repository scope note:** This Goal belongs to **Dev Exec**, not specifically to the ChatGPT MCP transport. It is colocated in `46slv/chatgpt-mcp` because this repository is currently the implementation home of Dev Exec. A future repository split or rename must preserve this Goal and its invariants rather than reinterpret it as a ChatGPT-transport-specific feature.

This Goal implements the initial **Ephemeral Agents** mechanism under the parent architecture. It may emit structured Decision Episodes for later Forge analysis, but it does not own Reflex policy, Skill promotion, canonical Mission state, or control-plane authority.

## Goal

Enable small-context local models to continue long-horizon Dev Exec problem solving without Mission duration being constrained by one model session's context window.

The target is not better compaction of a long conversation. The target is:

> **Decouple Mission length from Local Model context length.**

A Local Model inference is a short-lived reasoning episode. Durable Mission continuity, verified facts, problem state, attempts, evidence, failures, and routing remain outside the model under Dev Exec authority.

## Core operating model

Do not ask one Local Model session to perform the whole chain:

`read -> identify problem -> design solution -> act -> verify -> decide next work`

Split it into fresh ephemeral roles:

```text
FIND
  -> SOLVE
  -> VERIFY
       UNSOLVED -> fresh SOLVE
       SOLVED   -> GOAL_CHECK
                      INCOMPLETE -> fresh FIND
                      COMPLETE   -> STOP
                      BLOCKED    -> ESCALATE
```

### FIND

Read only the bounded Goal/current-state material needed to identify **one next problem** that advances the Mission.

It does not own implementation and does not need to solve the problem it finds.

### SOLVE

Receive one exact problem plus a bounded working set and protected constraints. Attempt only that problem.

Execution should reuse existing Dev Exec typed/local execution boundaries where possible. Solver self-report is not completion evidence.

### VERIFY

Independently judge the exact problem against deterministic evidence. Solver reasoning/transcript is not an input.

Normal outcomes: `SOLVED`, `UNSOLVED`, `BLOCKED`.

### GOAL_CHECK

Run only after a problem is verified `SOLVED`. Judge the original Goal/acceptance against verified current state.

Normal outcomes: `COMPLETE`, `INCOMPLETE`, `BLOCKED`.

A solved problem is not equivalent to a completed Goal.

## Non-negotiable context invariants

1. **Every reasoning role starts from a fresh Local Model context.**
2. **A role context is discarded when the role finishes even if unused context remains.**
3. Conversation history, reasoning transcript, and raw tool history are not forwarded to the next episode.
4. `UNSOLVED` does not continue the same Solver session. Dev Exec persists the structured attempt/evidence/failure and starts a fresh Solver episode.
5. `NEEDS_CONTEXT` does not append more context to the requesting session. The episode ends; Dev Exec validates/materializes the bounded request and launches a fresh episode.
6. Context expansion therefore implies context rotation.
7. Each role receives a role-specific projection of state, not the entire Mission state.
8. Per-episode input/output/file/byte/evidence budgets are mechanically bounded outside the model.

## Durable state boundary

Persist structured state, not conversation memory.

The durable reasoning state should be sufficient to reconstruct the next fresh episode and may include:

- Goal and acceptance criteria
- protected constraints / authority boundaries
- verified facts
- open questions
- current problem
- solved problem index
- accepted/rejected hypotheses where materially useful
- structured attempts
- deterministic evidence references/hashes
- failure fingerprints
- bounded working-set references
- progress delta
- next role/state-machine transition

Raw Local Model reasoning transcripts are not canonical state and must not become required handoff material.

## Context Firewall

Materialize only the information required for each role.

Conceptually:

```text
FIND       <- Goal + acceptance + verified state + bounded discovery
SOLVE      <- one Problem + exact working set + prior structured attempt result
VERIFY     <- Problem + expected result + deterministic evidence
GOAL_CHECK <- Goal + acceptance + verified progress/evidence
```

The design should reuse the proven principle of `codex-ephemeral-harness` Context Firewall/fresh-role operation, but this is a **Dev Exec generic local reasoning runtime**, not a replacement or fork of the Codex implementation harness.

## Authority / integration boundary

This feature must not make the Local Model a peer Control Plane.

```text
Dev Exec Parent
  owns Mission / durable state / routing / permissions / evidence / transition authority

Local Ephemeral Reasoner
  produces bounded role decisions

Typed Executor / Local Worker
  performs bounded actions

Verifier / deterministic evidence
  gates state transitions

Codex Closed Goal Loop
  remains an optional execution backend for larger coding Goals
```

Keep existing Dev Exec modes distinct:

- Local Model `RELAY`: hash-only transport authorization
- Ephemeral Reasoner: bounded reasoning episodes
- Local Worker / typed executor: bounded execution
- Codex CGL: supervised same-task Codex execution

Do not merge these authorities for convenience.

## Relationship to Reflex and Forge

The reasoning engine may return bounded facts, reason codes, candidate actions, selected action, and evidence requirements suitable for a `devexec.decision-episode`. Raw reasoning is not Forge input.

The parent architecture decides whether repeated verified episodes become a rule candidate. This Goal must not:

- activate a Reflex rule;
- expand a Skill's authority;
- replace an in-use adapter;
- promote its own output based only on self-report;
- bypass shadow evaluation or independent verification.

## Self-development target

The first high-value consumer is Dev Exec self-development:

```text
Dev Exec Goal
 -> fresh FIND
 -> fresh SOLVE
 -> bounded execution
 -> fresh VERIFY
 -> fresh GOAL_CHECK
 -> next fresh FIND / COMPLETE
```

This should eventually let Dev Exec inspect its own verified state, find one improvement problem, solve/verify it, and continue without accumulating Local Model conversational context.

## v0 implementation boundary

Keep v0 small. Prefer a minimal engine around existing Dev Exec runtime rather than a new general multi-agent framework.

Candidate mechanical pieces:

- EpisodeRunner
- ContextAssembler / role projections
- Role schemas
- Result validator
- State reducer
- Progress/failure detector

Initial roles are only `FIND`, `SOLVE`, `VERIFY`, `GOAL_CHECK`.

Implementation details may change as long as the Goal and context/authority invariants above are preserved.

## v0 acceptance

A bounded real Local Model run must prove at least:

1. One Mission continues for at least 10 reasoning episodes.
2. Every episode starts with fresh Local Model context/session state.
3. No conversation/reasoning transcript is forwarded between episodes.
4. Every episode remains within an explicit context budget.
5. At least 3 consecutive `UNSOLVED` attempts can occur without cumulative per-episode context growth.
6. `NEEDS_CONTEXT` terminates the current episode and resumes from a fresh one with only approved bounded material.
7. Solver and Verifier are separate episodes with separate inputs.
8. Problem `SOLVED` and Goal `COMPLETE` are separate state transitions.
9. Process restart can resume from durable state without the discarded model conversation.
10. `SOLVED` / `COMPLETE` cannot be accepted without required deterministic evidence.
11. A comparable long task shows materially lower peak Local Model context than the existing single-session/iterative path.
12. Existing Local Worker, RELAY, recovery/lease, and Closed Goal Loop authority/safety boundaries remain intact.

## Non-goals for v0

- infinite autonomous daemon
- transcript memory or replay
- vector-memory system
- automatic multi-model/tier scheduling
- unrestricted repository exploration
- Local Model ownership of Mission/routing authority
- Solver self-certification of success
- replacement of Codex Closed Goal Loop
- solving every long-context problem through summarization/compaction
- direct activation or promotion of Reflex rules and Skills

## Success condition

For routine Dev Exec reasoning, the operator should no longer need to treat "remaining Local Model context tokens" as a Mission-lifetime resource.

Each episode stays small and disposable; the Mission can continue across many episodes because continuity lives in validated Dev Exec state rather than in the model conversation.
