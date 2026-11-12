# Hermes Mission Packet — DEV-25 Portable Autonomous Coordination

Status: handoff candidate
Authority: user explicit request, 2026-11-12 JST
Mission: DEV-25 Agent Workboard / portable autonomous coordination core

## Goal

Hermes becomes the continuing Mission Owner for DEV-25 and drives the accepted Goal to a first usable autonomous coordination system. Do not wait for a new user message after routine checkpoints when the next action is already within standing authority.

## Read first

1. DEV-25 canonical Case: https://app.notion.com/p/411fd279a6f381768252cf43d129705b
2. Mission Skills canonical design: https://app.notion.com/p/3fbfd279a6f38189af04ed009b0a08a2
3. Hermes design / responsibility boundary: https://app.notion.com/p/408fd279a6f3819b9233e1808c3be73a
4. This packet and the attached `agent_coordination_core_canary.zip`.

Do not reconstruct the Mission from chat history when these sources are available.

## Current accepted state

- Architecture is state-centric: Design Agent, Mission Owner, and Workers are replaceable roles.
- Notion is Brief / Decision / human-facing projection, not the execution transaction boundary.
- Execution coordination core: open-source/self-hostable transactional service, initial backend SQLite.
- Workers mutate coordination state through a versioned Coordination API, not raw DB writes.
- `responsible_owner`, `active_executor`, `active_writer`, and `last_substantive_actor` are independent facts.
- Ownership changes only through explicit coordination events.
- Task and Attempt lifecycles are separate.
- Waiting can release executor capacity; ready workers may claim other work.
- Worker liveness becoming stale never auto-releases ownership or writer state.
- Shared non-file resources use explicit locks.
- Mission pins a harness revision; self-improvement promotes a future default before migrating active Missions.

## Existing implementation candidate

Artifact: `agent_coordination_core_canary.zip`

Current cloud prebuild:
- dependency-free Python stdlib
- SQLite transactional ledger
- localhost HTTP `/v1` Coordination API
- portable service entry point
- architecture/state-machine docs
- focused canary: 8/8 PASS

Verified behaviors include ownership vs last-actor separation, explicit handoff, waiting/yield, exclusive resource lease, unknown-inflight no-blind-retry, idempotent dispatch, API-bound claim/read, and rejection of unknown worker identity.

This artifact is a candidate, not yet the canonical Git source.

## First actions

1. Fresh-read the three canonical Notion sources above.
2. Inspect the artifact and current host/runtime before mutation.
3. Re-run the included focused tests on the actual Hermes host; record exact environment and result.
4. Create or select a dedicated code owner/repository for this coordination core; do not bury it in an unrelated project. Preserve the current artifact until the new owner is verified.
5. Continue DEV-25 Route 2:
   - harden/version the Coordination API contract;
   - add authenticated worker identity for non-local use while keeping local-only safe defaults;
   - implement Notion projection/readback without making Notion execution authority;
   - add the first real Hermes worker/owner adapter;
   - then connect at least one additional runtime/worker for the ownership canary.
6. Update DEV-25 Requirements / Route / Evidence / Next Action as actual results change. Do not duplicate the task plan into a second source of truth.
7. Continue autonomously into the next ready DEV-25 task after each accepted checkpoint.

## Done for the first Hermes handoff milestone

- Hermes can fresh-read DEV-25 and the Mission Skills contract.
- Hermes can access the implementation artifact or an equivalent durable code owner.
- The 8 focused tests are reproduced or failures are repaired with evidence.
- Hermes is recorded as the Mission Owner without conflating owner, executor, writer, or last actor.
- Route 2 has a durable code pointer and a real next action.
- No duplicate writer is created for an already-owned scope.

After this milestone, continue toward the DEV-25 First Usable acceptance rather than stopping for a status report.

## Standing authority / escalation

Routine reversible development, tests, ordinary Git work, repair, Notion state updates, and worker dispatch inside the accepted DEV-25 Goal may continue without asking at every checkpoint.

Escalate only for a material user-owned Goal/Done/product-intent change, credible unrecoverable destructive loss, incremental monetary spend/new paid commitment, unavailable required credential/person operation, or a platform-enforced confirmation.

## Return contract

Record durable results in DEV-25 and the code owner. Reports should contain only material deltas: accepted outcome, evidence, blocker, owner/writer change, and next action. Do not use chat transcript continuity as the Mission state.