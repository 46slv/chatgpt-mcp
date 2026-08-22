# Bridge multiline repair — Worker B adversarial review

Status: REVIEW BLOCKER FOUND
Reviewed candidate: `automation/bridge-multiline-repair-20260823` @ `aa42f2e893921ef8fe9218c2995d28c4b60b4fe7`
Base: `probe/windows-local` @ `8be1aa82c355f88280368d110bb88df216e8e674`

## What passed review

- The candidate no longer globally collapses whitespace with `replace(/\s+/g, ' ')`.
- Natural Protocol keeps the flat fallback fail-closed for ambiguous single-line PowerShell.
- The added rendered-browser shape (`RUN` header + standalone `powershell`/`pwsh`/`ps1` line + physical script lines) is a reasonable compatibility path for `innerText` extraction.
- Multiple standalone language markers fail closed.
- The real-host probe is bounded, non-elevated, uses one Dev Exec step, does not install dependencies, and validates persisted script/output markers.

## Blocking finding — payload text is still mutated by `cleanText()`

`src/chatgpt.ts` still removes every occurrence of UI-chrome phrases from the entire assistant turn before Natural Protocol parsing:

- `ChatGPT said:` / `ChatGPT said`
- `Pro thinking`
- `Answer now`
- `Extended thinking`
- `Show thinking`
- `Hide thinking`
- `Reasoning`
- `Thinking...` / `Thinking…`
- `• `

Because the candidate now intentionally transports executable multiline PowerShell verbatim, global phrase removal can silently rewrite valid script content.

Concrete reproduction using the candidate cleaner semantics:

Input:

```text
ChatGPT said:
RUN WorkingDirectory: C:\Work TimeoutSeconds: 300
powershell
Write-Output "ChatGPT said:"
Write-Output "Thinking..."
Write-Output "Answer now"
```

Observed cleaned payload:

```text
RUN WorkingDirectory: C:\Work TimeoutSeconds: 300
powershell
Write-Output ""
Write-Output ""
Write-Output ""
```

This is a correctness/safety issue because execution may still succeed while doing something different from the supervisor directive. The current 16-test suite and `verify-bridge-multiline-e2e.ps1` do not exercise payloads containing chrome-like phrases, so they cannot detect this class of mutation.

## Required correction before merge / host acceptance

Make chrome cleanup prefix-scoped, not payload-global.

Recommended invariant:

1. Normalize line endings first.
2. Find the first explicit supervisor intent boundary (`RUN`, `EXECUTE`, `STOP`, `NEEDS_HUMAN`, `NEEDS HUMAN`; include accepted Japanese intent forms if they can appear before extraction).
3. Apply UI-chrome/timing cleanup only to text before that boundary.
4. Preserve everything from the intent boundary onward byte-for-byte except the already-declared newline normalization and outer trim.
5. If no recognized intent boundary exists, retain the legacy prose-cleaning behavior for ordinary ChatGPT responses.

Do not solve this by adding more phrase exceptions inside PowerShell. The transport invariant should be that executable payload text is not semantically rewritten by UI cleanup.

## Regression coverage to add

Add producer and producer→consumer tests asserting that these strings survive inside the script exactly:

- `Write-Output "ChatGPT said:"`
- `Write-Output "Thinking..."`
- `Write-Output "Answer now"`
- a string containing `• `

Also strengthen the real-host probe so the persisted script is exactly the expected command sequence, not only a superset containing the expected lines.

## Host-only boundary after correction

After the payload-integrity tests pass in cloud, run `tools/verify-bridge-multiline-e2e.ps1` on SHIRO-WS against the intended target alias. Inspect the persisted `.ps1` and result JSON. Only then consider the clean candidate ready for merge/publication.
