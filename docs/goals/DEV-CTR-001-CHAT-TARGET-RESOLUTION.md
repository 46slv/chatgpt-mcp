# DEV-CTR-001 — Chat Target Discovery / Semantic Resolution

Status: PROPOSED / IMPLEMENTATION GOAL  
Scope: Dev Exec ChatGPT target discovery and binding

## Goal

Allow Dev Exec to locate an intended ChatGPT conversation using human-meaningful descriptors such as conversation title and Project membership, then resolve that descriptor to one exact canonical conversation identity before any send or autonomous run begins.

Human-facing names are discovery locators only. They must never become runtime authority.

> **title / project = locator; conversation_id + canonical URL = identity.**

## Core flow

```text
human-readable selector
  title / project / recent context
        ↓
Chat Discovery
        ↓
0 matches    -> NOT_FOUND
1 exact match -> RESOLVED
>1 matches   -> AMBIGUOUS
        ↓
exact canonical URL + conversation_id
        ↓
TaskChatBinding / target registry freeze
        ↓
normal exact-target chatgpt_reply / Dev Exec run
```

## Required discovery surfaces

Implementation may evolve, but the intended lookup order is:

1. currently open ChatGPT tabs;
2. visible/recent chats in the ChatGPT UI;
3. conversations within an explicitly named Project;
4. ChatGPT conversation-search UI where needed;
5. optional local discovery cache as a hint only, never as authority.

A cached result must be revalidated against the live ChatGPT identity before use.

## Non-negotiable identity and safety rules

1. Conversation title is not unique identity and may change.
2. Project name is not unique conversation identity.
3. Discovery occurs before binding; once resolved, the exact `conversation_id` and canonical URL are frozen for the run/task.
4. Active runs never re-resolve by title or Project name.
5. Multiple candidates must fail closed as `AMBIGUOUS`; do not choose by first result, recency, browser focus, or arrival order.
6. Zero candidates must fail as `NOT_FOUND`; do not silently fall back to `current-chat`, registry default, or arbitrary open tabs.
7. The resolved target must pass the same canonical URL and expected-conversation verification used by existing Dev Exec target handling.
8. Closed Goal Loop and other unattended paths keep their existing immutable `TaskChatBinding` semantics.

## Intended CLI / API shape

Exact syntax may change, but the user-facing capability should support flows equivalent to:

```powershell
node tools/devexec-target.mjs find --title "DevExec 自己開発" --project "Dev Exec"
```

and binding the single verified match:

```powershell
node tools/devexec-target.mjs bind devexec-supervisor --title "DevExec 自己開発" --project "Dev Exec"
```

Eventually a goal/run may accept a human selector directly:

```powershell
node tools/devexec-goal.mjs --chat-title "DevExec 自己開発" --project "Dev Exec" "..."
```

Internally this must still execute:

```text
selector -> discovery -> exact identity -> freeze -> run
```

## Integration boundary

This is a discovery/resolution layer in front of existing Dev Exec target authority. It does not replace:

- target registry;
- `TaskChatBinding`;
- exact `target_url` + `expected_conversation_id` verification;
- conversation single-flight;
- Closed Goal Loop correlation and replay safety.

Discovery is convenience. Identity remains exact.

## v0 acceptance

A bounded real ChatGPT UI probe must prove at least:

1. discovery by exact/near-exact conversation title;
2. discovery restricted to a specified Project;
3. one match resolves to canonical URL + `conversation_id`;
4. duplicate-title candidates produce `AMBIGUOUS` and no send;
5. missing title produces `NOT_FOUND` and no fallback;
6. title changes after binding do not reroute an already admitted run;
7. Project/title discovery never changes the immutable target of an active CGL task;
8. a resolved target can be registered/frozen and used by existing `chatgpt_reply` transport without weakening current verification;
9. no raw browser-focus or first-visible-tab heuristic becomes unattended authority;
10. existing target/Closed Goal Loop regression tests remain passing.

## Non-goals for v0

- fuzzy autonomous selection among multiple plausible conversations;
- using conversation titles as persistent IDs;
- automatic rerouting of active tasks when a chat is renamed or moved;
- replacing exact URL/conversation-id verification;
- cross-account or unauthorized workspace discovery;
- broad semantic search over conversation contents unless later added behind the same exact-resolution gate.

## Success condition

An operator can identify a ChatGPT destination using a natural stable-enough description such as "the Dev Exec self-development chat inside the Dev Exec Project", while Dev Exec still sends only after that description has been converted into one exact verified conversation identity.
