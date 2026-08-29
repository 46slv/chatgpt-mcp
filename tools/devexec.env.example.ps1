# DevExec local environment template (secrets-free).
# Dot-source this file in the shell that will run DevExec:
#   . .\tools\devexec.env.example.ps1
# All values are process-local. Edit the commented paths for this machine;
# do not commit a copied, machine-specific file.

# Read-only worker mode is the safe default. Set to 1 only for an explicit,
# reviewed write work package using a separate LocalExecutor profile.
$env:LOCAL_WORKER_ALLOW_WRITE = '0'

# Autonomous ordinary-text ChatGPT consultation is opt-in and remains disabled
# unless explicitly set to 1. The target alias is frozen at run start; the
# local model cannot choose the target, tool, or request id.
# $env:DEV_EXEC_CHATGPT_CONSULT_ENABLED = '1'
# Prepare the exact conversation first (no trailing slash/query/fragment).
# Direct conversation:
#   node tools/devexec-target.mjs set main https://chatgpt.com/c/<conversation-id>
# Project/custom-GPT-scoped conversation (also accepted):
#   node tools/devexec-target.mjs set main https://chatgpt.com/g/<project-or-g-slug>/c/<conversation-id>
# Then select the alias for consultation:
# $env:DEV_EXEC_CHATGPT_CONSULT_TARGET_ALIAS = 'main'
# $env:DEV_EXEC_CONSULTATION_STATE_DIR = 'C:\Users\<user>\AppData\Local\ChatGPTMCP\consultation-state'
# Optional consultation limits. Out-of-range numeric values are clamped;
# malformed values disable consultation fail-closed.
# $env:DEV_EXEC_CHATGPT_CONSULT_MAX_REQUESTS = '3'
# $env:DEV_EXEC_CHATGPT_CONSULT_MAX_CHARS = '12000'
# $env:DEV_EXEC_CHATGPT_CONSULT_EVIDENCE_CHARS = '6000'
# $env:DEV_EXEC_CHATGPT_CONSULT_TIMEOUT_MINUTES = '30'

# Optional overrides. The adapter has conservative defaults for omitted values.
# $env:LOCAL_WORKER_LMS = 'C:\Path\To\lms.exe'
# $env:LOCAL_WORKER_MODEL = 'your-local-model-id'
# $env:LOCAL_WORKER_EXECUTOR_ROOT = 'C:\Users\<user>\Documents\LocalExecutorRepo'
# $env:LOCAL_WORKER_PROBE_ROOT = 'C:\Users\<user>\Documents\ChatGPTMCPProbe'
# $env:LOCAL_WORKER_PROFILE = 'C:\Users\<user>\Documents\LocalExecutorRepo\profiles\chatgpt-mcp-probe-readonly.json'
# $env:LOCAL_WORKER_PYTHON = 'python'
# $env:LOCAL_WORKER_CONTEXT_WINDOW = '8192'
# $env:LOCAL_WORKER_MAX_PLANNER_ROUNDS = '3'
# $env:LOCAL_WORKER_PLANNER_TIMEOUT_MS = '75000'
# $env:LOCAL_WORKER_PLANNER_ATTEMPTS = '2'

# Optional persistent browser profile override. Keep it outside this repository.
# $env:CHATGPT_MCP_USER_DATA_DIR = 'C:\Users\<user>\AppData\Local\ChatGPTMCP\user-data'
# Optional visible Chrome CDP launcher overrides. The launcher never kills an
# existing browser or deletes this profile. Edge is disabled unless explicitly
# opted in with CHATGPT_MCP_ALLOW_EDGE=1 or the launcher's -AllowEdge switch.
# $env:CHATGPT_MCP_CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
# $env:CHATGPT_MCP_CDP_PORT = '9222'
# $env:CHATGPT_MCP_CHAT_URL = 'https://chatgpt.com'
# $env:CHATGPT_MCP_ALLOW_EDGE = '0'
# Optional attach transport: connect to an already-running, visible browser
# instead of launching a private persistent context. Only localhost endpoints
# are accepted, and shutdown disconnects without closing Chrome.
# $env:CHATGPT_MCP_CDP_URL = 'http://127.0.0.1:9222'

# Optional DevExec state/run roots. Keep runtime state outside this repository.
# $env:DEV_EXEC_STATE_DIR = 'C:\Users\<user>\AppData\Local\ChatGPTMCP\dev-exec-state'
# $env:DEV_EXEC_RUNS_DIR = 'C:\Users\<user>\AppData\Local\ChatGPTMCP\dev-exec-runs'
