# DevExec on Windows

This is the portable onboarding path for a new Windows machine. Replace `<user>` and other placeholders with local values; do not copy machine-specific paths or browser state into this repository.

## 1. Clone and build

Open PowerShell and choose a workspace outside the repository's runtime/state directories:

```powershell
Set-Location "$env:USERPROFILE\Documents"
git clone https://github.com/parkermg/chatgpt-mcp.git ChatGPTMCPProbe
Set-Location .\ChatGPTMCPProbe
npm ci
npx playwright install chromium
npm run build
npm test
```

`npm test` runs the deterministic DevExec MJS suite, the portability checks, and the read-only preflight. A missing LM Studio or browser listener is reported by preflight but does not make installation perform side effects.

## 2. Prepare ChatGPT and Chrome CDP

Use a dedicated Chrome profile so cookies remain outside the checkout. The
portable launcher selects an explicit `CHATGPT_MCP_CHROME_PATH`, then stable
system Chrome locations, then a `chrome` command, and finally the installed
Playwright Chromium. It starts a visible browser on localhost CDP port 9222;
the profile is selected by `CHATGPT_MCP_USER_DATA_DIR` or the home-relative
default. It never kills an existing browser, deletes a profile, edits the
registry, or writes browser configuration.

Preview path selection and arguments without launching:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\start-chatgpt-cdp.ps1 `
  -Plan -UserDataDir "$env:LOCALAPPDATA\ChatGPTMCP\chrome-cdp" -ChatUrl https://chatgpt.com
```

Start the visible session after reviewing the plan:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\start-chatgpt-cdp.ps1 `
  -UserDataDir "$env:LOCALAPPDATA\ChatGPTMCP\chrome-cdp" -ChatUrl https://chatgpt.com
```

Log in interactively in that window. If port 9222 is already a CDP listener,
the launcher reports `reuse_existing` and does not open another browser. If a
non-CDP process owns the port, it reports `blocked_port_in_use`; choose another
`-CdpPort` and pass the same port to target capture/verification. Microsoft
Edge is never selected implicitly; use `-AllowEdge` (or set
`CHATGPT_MCP_ALLOW_EDGE=1`) only when Edge compatibility is intentional.

## 3. Capture and verify a target

You can register a user-prepared conversation directly. The URL must be
exactly `https://chatgpt.com/c/<safe-id>` (no trailing slash, query, fragment,
port, userinfo, or extra path):

```powershell
node tools/devexec-target.mjs set my-chat https://chatgpt.com/c/<conversation-id>
node tools/devexec-target.mjs use my-chat
```

`register` is an equivalent spelling of `set`. The selected alias is frozen at
the beginning of each local-worker run, before the local planner is consulted;
the planner cannot choose a URL, target alias, MCP tool, or request ID. Resume
reuses the persisted frozen `{alias,url,conversation_id,source,frozen_at}` and
fails closed if the alias is missing or points to another conversation.

With the intended ChatGPT conversation open in the CDP Chrome window, a target
may also be captured and then verified:

```powershell
node tools/devexec-target.mjs capture main
node tools/devexec-target.mjs list
node tools/devexec-target.mjs verify main
```

The target registry is external runtime state at `$env:LOCALAPPDATA\DevExec\targets.json`. `verify` must resolve exactly one open tab for the captured conversation. `TARGET_NOT_OPEN` means the conversation is not open in the CDP-enabled profile (or the wrong port/profile is being checked); open the exact URL there and retry.

Before any worker action, check the selected target and use the safe dry-run:

```powershell
node tools/devexec-target.mjs current
node tools/devexec-goal.mjs --dry-run "describe the bounded task"
```

Dry-run performs no worker start and writes no durable state. Keep `LOCAL_WORKER_ALLOW_WRITE=0` unless a separate, reviewed write work package explicitly requires otherwise.

## 4. Optional local worker / LM Studio

LocalExecutor and model files are separate dependencies; they are intentionally not bundled here. Provision LocalExecutor from its approved source in a separate directory, then point this checkout at it with environment variables. Start LM Studio's local server using its normal UI/CLI and confirm the model identifier before running a worker.

```powershell
. .\tools\devexec.env.example.ps1
$env:LOCAL_WORKER_LMS = 'C:\Path\To\lms.exe'
$env:LOCAL_WORKER_MODEL = 'the-model-id-visible-in-lm-studio'
$env:LOCAL_WORKER_EXECUTOR_ROOT = "$env:USERPROFILE\Documents\LocalExecutorRepo"
$env:LOCAL_WORKER_PROBE_ROOT = "$env:USERPROFILE\Documents\ChatGPTMCPProbe"
$env:LOCAL_WORKER_ALLOW_WRITE = '0'
```

Set `LOCAL_WORKER_PROFILE` to the external LocalExecutor read-only profile when the default profile discovery is not suitable. Other bounded controls (`LOCAL_WORKER_CONTEXT_WINDOW`, `LOCAL_WORKER_MAX_PLANNER_ROUNDS`, `LOCAL_WORKER_PLANNER_TIMEOUT_MS`, and `LOCAL_WORKER_PLANNER_ATTEMPTS`) are optional environment overrides. Never put `mcp.json`, model caches, executor credentials, or runtime state under this checkout.

## 5. Optional autonomous ordinary-text consultation

The local planner is not allowed to select ChatGPT tools, targets, or request IDs. To permit bounded ordinary-text consultation, explicitly opt in for the process and freeze a target alias before starting a goal:

```powershell
$env:DEV_EXEC_CHATGPT_CONSULT_ENABLED = '1'
$env:DEV_EXEC_CHATGPT_CONSULT_TARGET_ALIAS = 'main'
# Optional bounded controls (defaults: 3 requests, 12,000 prompt chars,
# 6,000 evidence chars, 30-minute chatgpt_reply timeout):
# $env:DEV_EXEC_CHATGPT_CONSULT_MAX_REQUESTS = '2'
# $env:DEV_EXEC_CHATGPT_CONSULT_MAX_CHARS = '12000'
# $env:DEV_EXEC_CHATGPT_CONSULT_EVIDENCE_CHARS = '6000'
# $env:DEV_EXEC_CHATGPT_CONSULT_TIMEOUT_MINUTES = '30'
```

The runner uses only the fixed `chatgpt_reply` adapter. Prompts containing secrets or credentials, personal data, file upload/path requests, permissions, account or billing actions, destructive instructions, external/out-of-scope work, or unknown intent are durably `BLOCKED`. Requests are bounded to 12,000 characters; responses are retained as untrusted, truncated evidence (6,000 characters) and must re-enter the local planner before any typed LocalExecutor action. Request SHA-256 deduplication prevents duplicate replies. A transport failure is durable `DELIVERY_UNKNOWN`; an ambiguous request is never automatically resent. Disable the feature by omitting the opt-in variable (the default).

## 6. State and security boundaries

The normal external locations are:

- Browser profile: `%USERPROFILE%\.chatgpt-mcp\user-data` (override with `CHATGPT_MCP_USER_DATA_DIR`).
- Target registry: `%LOCALAPPDATA%\DevExec\targets.json`.
- DevExec state/runs: `%LOCALAPPDATA%\ChatGPTMCPProbe\dev-exec-state` and `dev-exec-runs` (override with `DEV_EXEC_STATE_DIR` / `DEV_EXEC_RUNS_DIR`).
- Consultation state: `%LOCALAPPDATA%\ChatGPTMCPProbe\consultation-state` (override with `DEV_EXEC_CONSULTATION_STATE_DIR`).
- LM Studio MCP configuration: `%USERPROFILE%\.lmstudio\mcp.json`.

Keep these outside Git and back them up using the machine's normal protected backup mechanism. Do not commit `.env` files, copied PowerShell environment files, cookies, browser profiles, target registries, `mcp.json`, LocalExecutor trees, model weights, state, run logs, or generated reports. The tracked env file is an example only and contains no secrets.

## 7. Read-only preflight and troubleshooting

Run the preflight whenever changing machines, profiles, or ports:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\devexec-preflight.ps1
```

It reports command availability, repository/build paths, existence and validity of config files (names only), localhost listeners, and whether the worker write flag/model overrides are set. It never installs, launches, logs in, writes state, or changes power/network/browser settings.

- `TARGET_NOT_OPEN`: start the CDP Chrome profile on port 9222, open the exact captured `chatgpt.com/c/<id>` URL, and run `node tools/devexec-target.mjs verify <alias>` again.
- `403` when publishing: the GitHub identity lacks write permission to the upstream repository. Push to an authorized fork/remote or obtain permission; do not force-push or rewrite history.
- Missing model / `MODEL_NOT_FOUND`: inspect the model id shown by LM Studio, set `LOCAL_WORKER_MODEL` exactly, ensure the LM Studio local server is listening on its configured port, and rerun preflight. No model is downloaded automatically.
- `CDP_UNAVAILABLE`: verify the port, profile, and Chrome process; do not broaden network exposure beyond localhost.
- `browser_not_found`: set `CHATGPT_MCP_CHROME_PATH` to an existing Chrome executable or install Playwright Chromium with `npx playwright install chromium`. Use `-Plan` first; no browser is started in plan mode.
- `early_exit` / `startup_timeout`: the browser was not terminated by the launcher. Check the reported executable/profile and existing process lock, then retry with a dedicated profile and bounded `-StartupTimeoutSeconds`.
- Consultation remains disabled unless `DEV_EXEC_CHATGPT_CONSULT_ENABLED=1` and a valid `DEV_EXEC_CHATGPT_CONSULT_TARGET_ALIAS` are present. `BLOCKED` and `DELIVERY_UNKNOWN` are expected fail-closed outcomes, not permission prompts to bypass.

For a new machine, the bounded completion check is: `npm ci`, Playwright Chromium installed, `npm run build`, `npm test` passing, target captured and verified, then a dry-run with write disabled. Live ChatGPT or LM Studio success depends on external login and local services and should be recorded separately from deterministic repository tests.
