import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { runTestCommand } from "./local-worker-runtime.mjs";

// This module is provider neutral: an OpenAI-compatible `infer` function is
// the only model dependency. The parent runtime still owns the repository
// boundary and recomputes the final diff after this loop returns.
export const MINIMAL_HARNESS_TOOLS = Object.freeze([
  { type: "function", function: { name: "read", description: "Read a bounded repository-relative text file.", parameters: { type: "object", properties: { path: { type: "string" }, max_chars: { type: "integer", minimum: 1, maximum: 16000 } }, required: ["path"], additionalProperties: false } } },
  { type: "function", function: { name: "search", description: "Search bounded text in repository files.", parameters: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 200 }, path: { type: "string" }, max_results: { type: "integer", minimum: 1, maximum: 40 } }, required: ["query"], additionalProperties: false } } },
  { type: "function", function: { name: "patch", description: "Replace or unified-patch one allowed file with bounded content after an optional SHA-256 check.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string", maxLength: 65536 }, patch: { type: "string", maxLength: 65536 }, expected_sha256: { type: "string", pattern: "^[0-9a-fA-F]{64}$" } }, required: ["path"], additionalProperties: false } } },
  { type: "function", function: { name: "run_test", description: "Run the task's fixed argv test command.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "git_diff", description: "Return bounded diff metadata/content for allowed paths.", parameters: { type: "object", properties: { path: { type: "string" }, max_chars: { type: "integer", minimum: 1, maximum: 16000 } }, additionalProperties: false } } },
]);

const DENIED_FILE = /(?:^|\/)(?:\.env(?:\.|$)|credentials?\.|secrets?\.|id_rsa|.*\.pem$|.*\.key$)/i;
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__"]);
const MAX_HISTORY = 20;
const MAX_OUTPUT = 16000;
const MAX_SEARCH_FILES = 300;

function bounded(value, max, fallback = "") {
  const text = value == null ? fallback : String(value);
  return text.length <= max ? text : `${text.slice(0, Math.floor(max / 2))}...[TRUNCATED]...${text.slice(-Math.floor(max / 2))}`;
}

function safeRelative(root, value, { allowOutside = false } = {}) {
  if (typeof value !== "string" || !value.trim()) throw new Error("path is required");
  const normalized = value.replaceAll("\\", "/");
  if (path.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")) throw new Error("path must be repository-relative");
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length || parts.includes("..") || parts.includes(".")) throw new Error("path escapes repository");
  const relative = parts.join("/");
  if (DENIED_FILE.test(relative)) throw new Error("sensitive path is not available");
  const candidate = path.resolve(root, relative);
  const rel = path.relative(root, candidate);
  if (!allowOutside && (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))) throw new Error("path escapes repository");
  return { relative, candidate };
}

function assertNoReparse(root, relative) {
  let current = root;
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("symlink/reparse path is not allowed");
  }
}

function allowedWrite(relative, task) {
  return task.allowed_paths.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`));
}

function clampArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("tool arguments must be an object");
  return args;
}

function parseArgs(raw) {
  if (raw == null || raw === "") return {};
  if (typeof raw === "object") return clampArgs(raw);
  try { return clampArgs(JSON.parse(String(raw))); } catch { throw new Error("tool arguments must be valid JSON"); }
}

function hashFile(file) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); } catch { return null; }
}

function applyUnifiedPatch(original, patch) {
  const source = String(original).split(/\r?\n/);
  const lines = String(patch).replace(/^```(?:diff)?\s*\r?\n/i, "").replace(/\r?\n```\s*$/i, "").split(/\r?\n/);
  const output = [];
  let cursor = 0;
  let sawHunk = false;
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index].match(/^@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@/);
    if (!header) continue;
    sawHunk = true;
    const oldStart = Number(header[1]) - 1;
    while (cursor < oldStart) output.push(source[cursor++]);
    index += 1;
    for (; index < lines.length && !/^@@ /.test(lines[index]); index += 1) {
      const line = lines[index];
      if (line === "\\ No newline at end of file") continue;
      const marker = line[0];
      const text = line.slice(1);
      if (marker === " ") {
        if (source[cursor] !== text) throw new Error("unified patch context mismatch");
        output.push(source[cursor++]);
      } else if (marker === "-") {
        if (source[cursor] !== text) throw new Error("unified patch removal mismatch");
        cursor += 1;
      } else if (marker === "+") output.push(text);
      else if (line.trim()) throw new Error("invalid unified patch line");
    }
    index -= 1;
  }
  if (!sawHunk) throw new Error("patch must contain unified hunks");
  while (cursor < source.length) output.push(source[cursor++]);
  return output.join("\n");
}

function listFiles(root, start, out, depth = 0) {
  if (out.length >= MAX_SEARCH_FILES || depth > 8) return;
  let entries;
  try { entries = fs.readdirSync(start, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (out.length >= MAX_SEARCH_FILES) break;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(start, entry.name);
    if (entry.isDirectory()) listFiles(root, full, out, depth + 1);
    else if (entry.isFile()) {
      const relative = path.relative(root, full).replaceAll("\\", "/");
      if (!DENIED_FILE.test(relative)) out.push({ full, relative });
    }
  }
}

async function executeTool(name, rawArgs, task, context) {
  const args = parseArgs(rawArgs);
  const root = path.resolve(task.worktree);
  if (name === "read") {
    const { relative, candidate } = safeRelative(root, args.path);
    assertNoReparse(root, relative);
    const max = Number.isInteger(args.max_chars) ? Math.min(16000, Math.max(1, args.max_chars)) : 8000;
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) throw new Error("file not found");
    return { path: relative, sha256: hashFile(candidate), content: bounded(fs.readFileSync(candidate, "utf8"), max) };
  }
  if (name === "search") {
    const query = bounded(args.query, 200);
    if (!query) throw new Error("query is required");
    const base = args.path ? safeRelative(root, args.path).candidate : root;
    if (args.path) assertNoReparse(root, safeRelative(root, args.path).relative);
    const files = [];
    if (fs.existsSync(base) && fs.statSync(base).isFile()) files.push({ full: base, relative: path.relative(root, base).replaceAll("\\", "/") });
    else listFiles(root, base, files);
    const maxResults = Number.isInteger(args.max_results) ? Math.min(40, Math.max(1, args.max_results)) : 20;
    const hits = [];
    for (const file of files) {
      if (hits.length >= maxResults) break;
      let text;
      try { text = fs.readFileSync(file.full, "utf8").slice(0, 65536); } catch { continue; }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && hits.length < maxResults; i += 1) if (lines[i].toLowerCase().includes(query.toLowerCase())) hits.push({ path: file.relative, line: i + 1, text: bounded(lines[i], 500) });
    }
    return { query, hits, truncated: hits.length >= maxResults || files.length >= MAX_SEARCH_FILES };
  }
  if (name === "patch") {
    const { relative, candidate } = safeRelative(root, args.path);
    assertNoReparse(root, relative);
    if (!allowedWrite(relative, task)) {
      const error = new Error(`patch path is outside allowed_paths: ${relative}`);
      error.code = "SCOPE_VIOLATION";
      throw error;
    }
    const currentHash = hashFile(candidate);
    if (args.expected_sha256 && currentHash !== String(args.expected_sha256).toLowerCase()) throw new Error("expected_sha256 mismatch");
    let content;
    if (typeof args.content === "string") content = args.content;
    else if (typeof args.patch === "string") content = applyUnifiedPatch(fs.existsSync(candidate) ? fs.readFileSync(candidate, "utf8") : "", args.patch);
    else throw new Error("content or unified patch is required");
    if (content.length > 65536) throw new Error("patch content is bounded");
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
    fs.writeFileSync(candidate, content, "utf8");
    return { path: relative, sha256: hashFile(candidate), bytes: Buffer.byteLength(content, "utf8") };
  }
  if (name === "run_test") {
    if (typeof context.runTest !== "function") throw new Error("run_test unavailable");
    return await context.runTest(task, { signal: context.signal });
  }
  if (name === "git_diff") {
    const relative = args.path ? safeRelative(root, args.path).relative : null;
    if (relative) assertNoReparse(root, relative);
    const argv = ["-C", root, "diff", "--no-ext-diff", "--no-color", "--", ...(relative ? [relative] : task.allowed_paths)];
    let diff;
    try { diff = execFileSync("git", argv, { encoding: "utf8", windowsHide: true, timeout: 10000 }); } catch (error) { throw new Error(`git diff failed: ${String(error?.message || error)}`); }
    return { path: relative, diff: bounded(diff, Number.isInteger(args.max_chars) ? Math.min(16000, Math.max(1, args.max_chars)) : 12000) };
  }
  const error = new Error(`unsupported harness tool: ${name}`);
  error.code = "TOOL_DENIED";
  throw error;
}

function extractChoice(body) {
  const choice = body?.choices?.[0];
  const message = choice?.message;
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  return { choice, message, calls };
}

function failureFingerprint(error) {
  return crypto.createHash("sha256").update(String(error?.code || "ERROR") + ":" + String(error?.message || error)).digest("hex");
}

export async function runMinimalHarness(task, { infer, signal, runTest, maxToolCalls = task.max_tool_calls, maxHistory = MAX_HISTORY, timeoutMs = task.timeout, outputLimit = task.output_limit, logger = () => {} } = {}) {
  if (typeof infer !== "function") return { status: "FAILED", code: "INFERENCE_UNAVAILABLE", reason: "inference function is required", tool_calls: 0 };
  const started = Date.now();
  const cap = Number.isInteger(maxToolCalls) ? Math.min(100, Math.max(1, maxToolCalls)) : 8;
  const historyCap = Number.isInteger(maxHistory) ? Math.min(MAX_HISTORY, Math.max(4, maxHistory)) : MAX_HISTORY;
  const deadline = started + (Number.isInteger(timeoutMs) ? Math.min(3600000, Math.max(1000, timeoutMs)) : 60000);
  const goal = bounded(task.goal, 12000);
  const system = [
    "You are a bounded local coding worker. Use only the typed tools below; never commit, reset, delete, or access secrets.",
    "Modify only files under allowed_paths. Finish with a concise ordinary-text summary after verifying with run_test and git_diff.",
    `Repository: ${task.repo}`, `Worktree: ${task.worktree}`, `Allowed paths: ${task.allowed_paths.join(", ") || "(none)"}`,
    `Goal: ${goal}`,
  ].join("\n");
  const messages = [{ role: "system", content: bounded(system, 12000) }, { role: "user", content: bounded(goal, 12000) }];
  let toolCalls = 0;
  const failures = new Map();
  const observations = [];
  while (Date.now() < deadline && toolCalls < cap) {
    if (signal?.aborted) return { status: "CANCELLED", code: "CANCELLED", reason: "harness cancelled", tool_calls: toolCalls, observations };
    const body = await infer({ messages: messages.slice(-historyCap), tools: MINIMAL_HARNESS_TOOLS, tool_choice: "auto", max_tokens: 1024, signal });
    const { message, calls } = extractChoice(body);
    if (!message || typeof message !== "object") return { status: "FAILED", code: "MALFORMED_RESULT", reason: "inference response has no message", tool_calls: toolCalls, observations };
    if (!calls.length) {
      return { status: "PASS", summary: bounded(message.content || "completed", outputLimit), response: body, tool_calls: toolCalls, observations, metrics: { wall_time_ms: Date.now() - started, tool_calls: toolCalls, first_tool: observations[0]?.name || null } };
    }
    messages.push({ role: "assistant", content: message.content || null, tool_calls: calls.map((call) => ({ id: String(call.id || `call-${toolCalls + 1}`), type: "function", function: { name: String(call.function?.name || ""), arguments: String(call.function?.arguments || "{}") } })) });
    for (const call of calls) {
      if (toolCalls >= cap) break;
      toolCalls += 1;
      const name = String(call.function?.name || "");
      const callId = String(call.id || `call-${toolCalls}`);
      let result;
      try {
        result = await executeTool(name, call.function?.arguments, task, { runTest, signal });
      } catch (error) {
        const fp = failureFingerprint(error);
        const count = (failures.get(fp) || 0) + 1;
        failures.set(fp, count);
        const code = error?.code || "TOOL_FAILED";
        if (code === "SCOPE_VIOLATION") return { status: "BLOCKED", code, reason: "worker requested a patch outside allowed_paths", tool_calls: toolCalls, observations };
        if (count >= 2) return { status: "BLOCKED", code: "DUPLICATE_FAILURE", reason: "duplicate tool failure threshold reached", tool_calls: toolCalls, observations };
        result = { error: code, message: bounded(error?.message || error, 1000) };
      }
      const toolOk = !result?.error && (name !== "run_test" || result?.status === "PASS");
      observations.push({ name, ok: toolOk });
      const encoded = bounded(JSON.stringify(result), MAX_OUTPUT);
      messages.push({ role: "tool", tool_call_id: callId, name, content: encoded });
      logger({ event: "harness_tool", name, ok: !result?.error, tool_calls: toolCalls });
      if (Date.now() >= deadline) break;
    }
  }
  const completedEvidence = observations.some((x) => x.name === "patch" && x.ok)
    && observations.some((x) => x.name === "run_test" && x.ok)
    && observations.some((x) => x.name === "git_diff" && x.ok);
  if (completedEvidence) return { status: "PASS", summary: "bounded harness completed after tool-call limit", tool_calls: toolCalls, observations, metrics: { wall_time_ms: Date.now() - started, tool_calls: toolCalls, first_tool: observations[0]?.name || null } };
  const timedOut = Date.now() >= deadline;
  return { status: "FAILED", code: timedOut ? "HARNESS_TIMEOUT" : "HARNESS_MAX_TOOL_CALLS", reason: timedOut ? "harness deadline exceeded" : "maximum tool calls reached", tool_calls: toolCalls, observations, metrics: { wall_time_ms: Date.now() - started, tool_calls: toolCalls, first_tool: observations[0]?.name || null } };
}
