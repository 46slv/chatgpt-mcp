# DEV-CGL-006 — Completion-driven semantic closed loop

This task extends CGL-005's exact same-thread relay into a loop whose normal
terminal is decided by the fixed ChatGPT Supervisor, not by Codex's wording or
by a round counter.

## Contract

For each exact completed Codex turn, the parent builds and hashes a report
containing the goal/current task, branch and HEAD, changed paths, validation,
diff evidence, source turn identity, Codex self-report, unresolved blockers,
and parent-verifiable evidence. The report is sent through the existing
hash-only Local Model `RELAY` gate to the immutable `TaskChatBinding`.

The Supervisor must return one correlated `devexec.codex-prompt` envelope:

- `CONTINUE` with an exact `prompt`: approve the exact prompt through RELAY,
  queue it to the same bound Codex thread, and observe the resulting turn.
- `COMPLETE`: semantic goal completion; persist a terminal cycle and do not
  queue.
- `NEEDS_HUMAN`: human-intervention terminal; persist and do not queue.
- `STOP`: retained for bounded/operator compatibility; it is not semantic
  completion.

Every cycle persists a deterministic cycle/round id, source turn id and hash,
report hash, relay request id, decision, Supervisor response hash, next-task
hash, queue submission id, resulting turn id/hash, and same-thread proof.

## Mode and safety

Use `--until-complete` (or `--mode completion-driven` at admission). In this
mode `max_rounds` is not a normal terminal; an optional `safety_max_rounds` or
wall-clock budget yields `SAFETY_LIMIT_REACHED`. Legacy bounded mode keeps its
`max_rounds`/`MAX_ROUNDS_REACHED` behavior.

Restart resumes only from exact persisted state. `IN_FLIGHT`, unknown delivery,
hash/correlation mismatch, identity drift, ownership conflict, corrupt state,
or unsafe continuation fail closed. No ambiguous report resend or Codex
re-injection is permitted.

The real canary must be a harmless repository development task in which the
Supervisor requests at least one additional task on the same thread and then
returns `COMPLETE`; an acknowledgement-only probe does not prove this contract.

Canary status is runtime-only. A missing eligible persisted thread, an active
writer on the protected checkout, an archived source thread, or any identity
drift is `NEEDS_HUMAN`; the acceptance process must not create/unarchive a
replacement thread or use a fallback target.
