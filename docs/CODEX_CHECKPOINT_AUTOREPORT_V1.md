# Codex Checkpoint Autoreport v1

Status: candidate / pre-host qualification. This document does not claim live ChatGPT delivery on this candidate.

## Goal

Make a long-running Codex/Astra Mission use one durable checkpoint mechanism that also reports meaningful checkpoints to one exact bound ChatGPT conversation, while keeping Astra/Codex as execution owner.

The contract is runtime-neutral (`CheckpointEvent v1 -> ReportReceipt v1`) so EPHEMERA-System can later adopt the same semantics as its System-owned Mission event path.

## v1 topology

```text
Codex/Astra
  -> checkpoint_bind(workspace, mission, exact prepared target)
  -> execute autonomously
  -> checkpoint_save(REPORT)
       -> immutable checkpoint event = durable outbox
       -> return to Astra immediately
       -> background exact-bound ChatGPT send
       -> exact new user-turn acknowledgement
       -> terminal report receipt (`USER_TURN_ACK`)
  -> continue autonomously

material judgment boundary
  -> checkpoint_save(CONSULT)
       -> same durable event
       -> wait for exact ChatGPT response
       -> receipt + bounded response
       -> Astra reconciles with live state
```

Codex user-level hooks add two mechanical guards:

- `SessionStart`: records exact Codex session identity for the workspace.
- `Stop`: if an active bound workspace has no checkpoint from that session, continue Codex once with an instruction to create a meaningful checkpoint. A pending ordinary REPORT does not block stopping; a pending CONSULT does.

## Durable state

Default root:

`%LOCALAPPDATA%/ChatGPTMCPProbe/checkpoint-autoreport-v1`

The checkpoint journal is append-only. The immutable checkpoint event is also the outbox record. Delivery state lives separately in claim/receipt files so reporting never changes checkpoint identity.

A claim is created before external send. If a process dies after remote acceptance but before receipt persistence, the claim remains and future dispatch refuses blind resend.

## MCP tools

- `checkpoint_bind`
- `checkpoint_save`
- `checkpoint_status`
- `checkpoint_dispatch`

`REPORT` is background/non-blocking for the agent. `CONSULT` is synchronous.

## Codex local installation

After this candidate is checked out into a durable directory and built on the real Windows host, first inspect the dry-run plan.

The installer preserves existing `~/.codex/hooks.json`, makes a backup when replacing it, adds only the SessionStart/Stop handlers, and links/copies the reusable skill into `$HOME/.agents/skills/checkpoint-autoreport`.

Do not install from an OS temporary checkout. Keep the exact candidate in a durable directory, run `npm run build`, then review the dry-run plan. `--register-mcp` additionally registers the exact built `dist/index.js` as the user-level Codex MCP server `checkpoint_autoreport`; an existing different registration is refused instead of overwritten.

```powershell
node .\tools\install-checkpoint-codex.mjs --dry-run
node .\tools\install-checkpoint-codex.mjs --register-mcp
codex mcp get checkpoint_autoreport --json
```

Codex must review/trust the new hook definitions before they run. Restart Codex after installing hooks/MCP/Skill so one fresh session sees one coherent configuration.

## Pre-host checks included in candidate

- checkpoint event append-only sequence and stable identity
- exact target binding and rebind drift refusal
- Git HEAD/branch/dirty/changed-path observation
- likely-secret rejection in semantic checkpoint fields
- REPORT/CONSULT packet shaping without absolute workspace path disclosure
- delivery receipt dedupe
- `DELIVERY_UNKNOWN` terminal/no blind retry
- Stop hook: unbound no-op, active-session checkpoint enforcement, no infinite continuation
- installer merge/idempotence/dry-run behavior

## Real Windows host acceptance gate

Do not claim this candidate usable until all rows below are executed on SHIRO-WS (or the intended Codex machine) against the exact candidate SHA.

1. `npm run build` PASS.
2. Focused Node tests PASS from the exact checkout.
3. Installer `--dry-run` shows only the intended user Skill + hooks changes.
4. Actual install succeeds; `/hooks` shows reviewed/trusted SessionStart and Stop hooks.
5. Prepared exact ChatGPT target alias resolves to the intended conversation.
6. New Codex session records a session marker.
7. `checkpoint_bind` binds one test workspace/Mission to that exact conversation.
8. First `checkpoint_save(REPORT)` returns without waiting for a ChatGPT answer; checkpoint event exists immediately.
9. The exact ChatGPT conversation receives exactly one report containing the matching `report_id`; receipt becomes `DELIVERED` with `delivery_proof=USER_TURN_ACK` after the exact posted user turn is acknowledged. No assistant-response wait is required for REPORT.
10. A second material REPORT advances sequence exactly once and does not resend the first.
11. Attempting to stop an active fresh Codex session before any checkpoint causes exactly one Stop continuation. A final REPORT that is not yet confirmed also gets one bounded continuation so the background user-turn acknowledgement can finish; a second stop never loops forever and preserves unresolved ambiguity without blind resend.
12. `checkpoint_save(CONSULT)` waits for the same-conversation reply, records the receipt, and returns the bounded reply to Codex.
13. A simulated ambiguous/in-flight claim is not automatically resent; `checkpoint_status` exposes the unresolved state.
14. No existing Codex hooks/skills, target registry entries, or unrelated ChatGPT conversations are modified.

## Not in v1

- EPHEMERA-System adapter implementation (contract only; System remains future single-writer when it owns the Mission)
- automatic semantic checkpoint generation on every tool event
- blind claim cleanup/retry
- full secret-DLP engine
- multi-target fan-out
- using ChatGPT advice as Mission authority
