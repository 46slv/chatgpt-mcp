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

# SHIRO-WS standard local lane: Spark-X2.5-4B Q6_K through llama.cpp Vulkan.
# These values are safe to dot-source; a missing model/command remains a
# fail-closed startup error.  The model path is intentionally machine-local.
$env:DEV_EXEC_RUNTIME = 'local'
$env:DEV_EXEC_PROVIDER = 'llamacpp'
$env:DEV_EXEC_LOCAL_ENABLED = '1'
$env:LLAMACPP_ENABLED = '1'
$env:LLAMACPP_MODEL = 'Spark-X2.5-4B-Q6_K.gguf'
$env:LLAMACPP_SERVE_URL = 'http://127.0.0.1:18080'
$env:LLAMACPP_CONTEXT = '32768'
$env:LLAMACPP_DEVICE_NAME = 'NVIDIA GeForce RTX 3070 Ti'
# Set this to the exact qualified GGUF path on the host:
# $env:LLAMACPP_MODEL_PATH = 'C:\path\to\Spark-X2.5-4B-Q6_K.gguf'
# Set the absolute llama.exe path used by the startup/worker launcher:
# $env:LLAMACPP_COMMAND = 'C:\path\to\llama.exe'
# 64K is an explicit long-context lane; do not make it the normal default:
# $env:LLAMACPP_CONTEXT = '65536'

# Optional overrides. The adapter has conservative defaults for omitted values.
# $env:LOCAL_WORKER_EXECUTOR_ROOT = 'C:\Users\<user>\Documents\LocalExecutorRepo'
# $env:LOCAL_WORKER_PROBE_ROOT = 'C:\Users\<user>\Documents\ChatGPTMCPProbe'
# $env:LOCAL_WORKER_PROFILE = 'C:\Users\<user>\Documents\LocalExecutorRepo\profiles\chatgpt-mcp-probe-readonly.json'
# $env:LOCAL_WORKER_PYTHON = 'python'
# $env:LOCAL_WORKER_CONTEXT_WINDOW = '32768'
# $env:LOCAL_WORKER_MAX_PLANNER_ROUNDS = '3'
# $env:LOCAL_WORKER_PLANNER_TIMEOUT_MS = '75000'
# $env:LOCAL_WORKER_PLANNER_ATTEMPTS = '2'

# Explicit compatibility lane only. It never participates in implicit
# fallback and must be selected by naming the provider/model.
# $env:LOCAL_WORKER_PROVIDER = 'lmstudio'
# $env:LOCAL_WORKER_LMS = 'C:\Path\To\lms.exe'
# $env:LOCAL_WORKER_MODEL = 'the-explicit-compat-model-id'
# $env:LOCAL_WORKER_CONTEXT_WINDOW = '8192'

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
