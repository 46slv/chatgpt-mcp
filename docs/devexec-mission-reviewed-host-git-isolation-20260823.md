# Dev Exec Mission reviewed-host Git isolation — 2026-08-23

Status: Worker A implementation checkpoint; SHIRO-WS host acceptance remains required.

## Starting authority

This branch starts from Worker B `automation/devexec-mission-raw-nested-git-review-20260823@09dac89bc3a285d71b0d71646b861d28ab0ba2b7`.

Worker B closed two source-authority gaps in the RAW bootstrap: nested `.git` metadata is forbidden, and inherited Git routing/config authority is rejected before bootstrap mutation. The remaining explicit host condition was that the **post-bootstrap ordinary verifier and unchanged reviewed host packet** also need deterministic Git authority isolation.

The reviewed host source being accepted remains commit `3778734b6fc1a9e22b59adaa49803ac1daca49e2`, tree `ddc1f9ed6b09421b441f14a4afdc0137d68ba148`. This branch is a helper/reliability branch; it does not relabel its own HEAD as the reviewed host payload.

## Implementation

### One shared Git-authority contract

`tools/devexec-mission-reviewed-host-git-env.mjs` centralizes the Git environment rules used by both RAW bootstrap and post-bootstrap host launch:

- repository routing variables are removed from child processes;
- explicit system/global/config-parameter authority and `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` injection are removed;
- `GIT_CONFIG_COUNT=0`;
- `GIT_CONFIG_NOSYSTEM=1`;
- `GIT_CONFIG_GLOBAL` is pinned to the null device;
- `GIT_ATTR_NOSYSTEM=1`;
- `GIT_NO_REPLACE_OBJECTS=1`.

The RAW bootstrap now imports this shared implementation instead of maintaining a second private copy. Its pre-mutation inherited-environment rejection remains fail-closed.

### Reviewed-host launcher

`tools/devexec-mission-reviewed-host-launch.mjs` is intentionally a **post-bootstrap** launcher. It does not create or weaken source authority. It requires an already reconstructed reviewed workspace, then under the isolated child environment:

1. verifies Git top-level equals the requested reviewed root;
2. verifies exact reviewed HEAD;
3. verifies the worktree is clean;
4. runs the ordinary Mission reliability verifier and requires exact `MISSION_RELIABILITY_CHECK=PASS`;
5. runs the unchanged `verify-devexec-mission-host-acceptance.ps1` pinned to the same reviewed HEAD and requires exact `MISSION_HOST_ACCEPTANCE=PASS`;
6. rechecks exact HEAD and clean status after both components.

The launcher fails closed on a missing reviewed root, invalid/blank PowerShell executable, wrong HEAD, dirty worktree, missing PASS marker, spawn failure, or postflight drift. Optional evidence-root forwarding is explicit.

The existing Mission reliability verifier includes syntax/test coverage for the shared Git-environment helper and reviewed-host launcher. It does **not** execute SHIRO-WS host acceptance automatically.

## Cloud validation actually performed

- GitHub branch/file/write readback after every coherent write; no concurrent Worker B change was overwritten.
- Focused helper tests prepared for inherited-routing/config detection, `GIT_CONFIG_COUNT=0` semantics, and child-environment isolation.
- Focused launcher tests prepared for isolated child environment, exact HEAD fence, exact PASS-marker fences, evidence-root forwarding, required explicit root/PowerShell inputs, and spawn-error fail-loud behavior.
- A real Git probe in the cloud reproduced foreign `GIT_DIR` redirection and then proved the isolated environment restores the requested repository authority: `REVIEWED_HOST_GIT_ISOLATION_REAL_GIT_PROBE=PASS`.
- RAW bootstrap was refactored to the same shared authority helper; its regression expectation was updated to require `PRECHECKED_AND_SANITIZED_SHARED_CONTRACT`.

Not claimed: full committed Mission test bundle on a real checkout at this branch, PowerShell execution in this cloud container, GitHub CI, Windows/SHIRO-WS behavior, `SUMMARY.json` / `VERIFICATION.json` host evidence, Local Agent/Local Executor E2E, remaining forced-kill matrix, or power-loss/fsync durability.

## SHIRO-WS acceptance sequence

1. Start from a shell without inherited Git routing/config-injection variables.
2. Reconstruct the isolated RAW mirror for reviewed source tree `ddc1f9ed6b09421b441f14a4afdc0137d68ba148`.
3. Use the RAW exact-commit bootstrap and pinned commit object to restore HEAD `3778734b6fc1a9e22b59adaa49803ac1daca49e2`; require exact tree and clean status.
4. From this helper branch, invoke:

```powershell
node .\tools\devexec-mission-reviewed-host-launch.mjs `
  --reviewed-root <REVIEWED_RAW_ROOT> `
  --expected-head 3778734b6fc1a9e22b59adaa49803ac1daca49e2 `
  --powershell powershell.exe
```

5. Require `MISSION_REVIEWED_HOST_LAUNCH=PASS` and the underlying host packet's `SUMMARY.json`, `VERIFICATION.json`, hashes, five component logs, and `mission_probe_root` readback.
6. Only after this closes proceed to Local Agent/Local Executor and the remaining kill/restart acceptance.

`GOAL_PATCH / supersede_current_goal`, Control API/service, and GUI remain gated behind DEV-002 reliability closure.
