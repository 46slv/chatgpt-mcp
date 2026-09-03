# DEV-LER-001 v0 — First Vertical Slice

Status: READY

Goal authority: `docs/goals/DEV-LER-001-LOCAL-EPHEMERAL-REASONING.md`

This task is the first implementation slice of DEV-LER-001. Do not redesign the Goal. Preserve its context and authority invariants.

## Objective

Implement the smallest coherent Dev Exec-local runtime seam that can execute disposable reasoning episodes with durable parent-owned state.

The first slice should prove the state-machine boundary before attempting a full autonomous self-development loop.

## Required behavior

Introduce a minimal episode runtime capable of representing these roles:

- `FIND`
- `SOLVE`
- `VERIFY`
- `GOAL_CHECK`

Each role invocation must be modeled as a fresh episode. Episode output is validated structured data; raw reasoning/conversation history is not canonical handoff state.

At minimum, establish:

1. a parent-owned durable Mission/episode state schema;
2. role-specific input projection / bounded context assembly seam;
3. role output schemas and validation;
4. state transition rules for:
   - `FIND -> SOLVE`
   - `SOLVE -> VERIFY`
   - `VERIFY: UNSOLVED -> fresh SOLVE`
   - `VERIFY: SOLVED -> GOAL_CHECK`
   - `GOAL_CHECK: INCOMPLETE -> fresh FIND`
   - `GOAL_CHECK: COMPLETE -> terminal`
   - `BLOCKED -> terminal/escalation`;
5. explicit episode identity proving the next role is a new invocation, not continuation of prior conversation state;
6. a deterministic fake-model E2E proving at least one solved path and one UNSOLVED retry path without transcript forwarding.

## Scope constraints

- Reuse existing Dev Exec runtime, evidence, recovery, lease, and local-provider seams where practical.
- Do not replace `RELAY`, Local Worker, or Codex Closed Goal Loop.
- Do not give the Local Model routing, Mission, target, runtime, or completion authority.
- Do not introduce vector memory, transcript replay, a generic multi-agent framework, or unrestricted repo exploration.
- Do not attempt every DEV-LER-001 acceptance item in this first slice.
- Prefer a small module boundary plus focused tests over broad refactoring.

## Supervisor interaction

This development run is supervised by the user-designated Dev Exec ChatGPT conversation through runtime target alias `devexec-supervisor`.

The real conversation URL is runtime state and must not be committed.

Use the existing Dev Exec target/consultation/escalation boundaries. Ask the Supervisor only at meaningful architecture/acceptance boundaries or when blocked; ordinary implementation remains local.

When reporting to the Supervisor, include only bounded evidence:

- exact branch / HEAD;
- files changed;
- focused tests and results;
- current episode/state-machine behavior;
- unresolved decision/blocker;
- proposed next smallest slice.

## Done for this slice

This task is Done when:

- the minimal runtime/state-machine seam exists;
- deterministic tests prove fresh episode identities and no transcript-forwarding requirement;
- an `UNSOLVED -> fresh SOLVE` retry is represented and tested;
- existing relevant Dev Exec tests still pass;
- evidence is sufficient for the Supervisor to decide the next slice;
- no claim is made that full DEV-LER-001 is complete.
