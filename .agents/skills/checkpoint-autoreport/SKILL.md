---
name: checkpoint-autoreport
description: Use for long-running autonomous Codex/Astra missions that should create durable semantic checkpoints and report them automatically to one exact bound ChatGPT conversation without turning ChatGPT into the execution coordinator.
---

# Checkpoint Autoreport

Use this skill for a bounded long-running Mission when durable resume + autonomous ChatGPT progress reporting is desired.

## Mission start

1. Determine the Git workspace root.
2. Choose one stable `mission_id` for the entire Mission.
3. Call the `checkpoint_bind` tool exposed by the configured chatgpt-mcp server with:
   - `workspace`
   - `mission_id`
   - concise `goal`
   - `target_alias` when a non-default prepared target is required.
4. Do not replace an existing different binding unless the user/runtime explicitly intends a new Mission lineage.

## During execution

Astra/Codex owns planning, implementation, repair, and next-task selection.

At a material semantic boundary call `checkpoint_save` with only the semantic delta:
- `next`: the single best next task
- `approach`: how to start and what evidence would change the approach
- `done_for_next`: observable exit condition when useful
- `mode`: `REPORT` by default
- `evidence_refs`: short pointers only; do not paste raw logs or secrets

Use `CONSULT` only for a material architecture/product/authority decision, serious risk, or unresolved evidence contradiction. Include one explicit `question`. CONSULT waits for ChatGPT; REPORT does not.

Do not checkpoint every command/test/read. Good boundaries include a coherent work unit closing, a material design decision, context rollover, a delegated read that changes direction, or a pre-terminal/final state.

After a REPORT checkpoint, continue immediately when the Mission authority permits. REPORT delivery means the exact posted user turn was acknowledged in the bound conversation; it does not wait for an assistant answer. ChatGPT does not own the next task.

## Before stopping

The installed Stop hook checks that an active bound workspace has at least one checkpoint from the current Codex session. If it asks for a checkpoint, create one meaningful checkpoint; do not create dummy text merely to silence the hook.

If the latest REPORT is still pending at stop time, the Stop hook may continue once so its exact user-turn acknowledgement can finish. If the latest checkpoint is CONSULT, do not stop until its exact ChatGPT delivery/readback is confirmed or the Stop hook has already continued once and reports an unresolved reconciliation condition.

Use `checkpoint_status` when delivery state is unclear. Never blind-resend `DELIVERY_UNKNOWN` or an event with an existing claim.

## Authority boundary

Checkpoint/report state is advisory continuity. Current repo/runtime/tests remain execution truth. For a future EPHEMERA-managed Mission, EPHEMERA-System becomes the single canonical checkpoint writer and this Codex adapter must submit into that System-owned event path rather than maintain a competing journal.
