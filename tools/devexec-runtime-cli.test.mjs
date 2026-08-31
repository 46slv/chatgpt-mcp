import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRecoveryJournal } from "./local-runtime-recovery-journal.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "tools", "devexec.mjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-runtime-cli-"));
  fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "DevExec Test"]);
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "fixture"]);
  const base = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return { root, base };
}

function taskFile(f, extra = {}) {
  const file = path.join(os.tmpdir(), `devexec-task-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    task_id: "cli-fixture",
    repo: f.root,
    worktree: f.root,
    cwd: f.root,
    base_commit: f.base,
    goal: "bounded local edit",
    allowed_paths: ["src/value.txt"],
    constraints: ["no commit"],
    test_command: [process.execPath, "-e", "process.exit(require('fs').readFileSync('src/value.txt','utf8').trim()==='ok'?0:1)"],
    timeout: 30000,
    max_tool_calls: 4,
    output_limit: 4000,
    ...extra,
  }, null, 2));
  return file;
}

function adapterFile(f, body) {
  const file = path.join(os.tmpdir(), `devexec-adapter-${process.pid}-${Math.random().toString(16).slice(2)}.mjs`);
  fs.writeFileSync(file, body);
  return file;
}

function invoke(args) {
  const result = spawnSync(process.execPath, [CLI, "runtime", "run", ...args], { encoding: "utf8", windowsHide: true });
  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch { /* assertion below reports malformed stdout */ }
  return { ...result, parsed };
}

test("public runtime run accepts a versioned task and injected adapter", () => {
  const f = fixture();
  const task = taskFile(f);
  const adapter = adapterFile(f, `import fs from "node:fs"; export function createAdapter() { return { identity: { runtime: "local", provider: "freetoken", model: "fake" }, async run(task) { fs.mkdirSync(task.worktree + "/src", { recursive: true }); fs.writeFileSync(task.worktree + "/src/value.txt", "ok\\n"); return { status: "PASS", metrics: { first_tool: "apply_patch", tool_calls: 1 } }; } }; }`);
  const evidence = path.join(os.tmpdir(), `devexec-cli-evidence-${process.pid}.json`);
  const result = invoke(["--task", task, "--runtime", "local", "--provider", "freetoken", "--adapter-module", adapter, "--evidence", evidence]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.parsed.version, 1);
  assert.equal(result.parsed.status, "DONE");
  assert.deepEqual(result.parsed.changed_files, ["src/value.txt"]);
  assert.equal(result.parsed.runtime_provider_identity.model, "fake");
  const saved = JSON.parse(fs.readFileSync(evidence, "utf8"));
  assert.equal(saved.result.status, "DONE");
  assert.equal(JSON.stringify(saved).includes("source body"), false);
});

test("default and disabled selectors never load or invoke a local adapter", () => {
  const f = fixture();
  const task = taskFile(f);
  const adapter = adapterFile(f, `throw new Error("local adapter must not load");`);
  for (const flags of [[], ["--runtime", "local", "--provider", "freetoken", "--disabled"]]) {
    const result = invoke(["--task", task, "--adapter-module", adapter, ...flags]);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.parsed.status, "BLOCKED");
    assert.match(result.parsed.blocker, /explicit local FreeToken runtime|required|not started/i);
  }
});

test("malformed and unknown-field task files fail closed with truthful input evidence", () => {
  const f = fixture();
  const unknown = taskFile(f, { typo_field: true });
  const evidence = path.join(os.tmpdir(), `devexec-cli-malformed-${process.pid}.json`);
  const result = invoke(["--task", unknown, "--runtime", "local", "--provider", "freetoken", "--evidence", evidence]);
  assert.equal(result.status, 2);
  assert.equal(result.parsed.status, "BLOCKED");
  assert.match(result.parsed.blocker, /unknown task fields/i);
  assert.equal(JSON.parse(fs.readFileSync(evidence, "utf8")).result.status, "BLOCKED");
});

test("provider unavailable is reported as BLOCKED without a fake success", () => {
  const f = fixture();
  const task = taskFile(f);
  const adapter = adapterFile(f, `export default { identity: { runtime: "local", provider: "freetoken", model: "unavailable" }, async run() { return { status: "BLOCKED", code: "UNAVAILABLE" }; } };`);
  const result = invoke(["--task", task, "--runtime", "local", "--provider", "freetoken", "--adapter-module", adapter]);
  assert.equal(result.status, 2);
  assert.equal(result.parsed.status, "BLOCKED");
  assert.match(result.parsed.blocker, /provider blocked/i);
});

test("read-only metrics summary is exposed through the public dispatcher", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-metrics-summary-"));
  const result = spawnSync(process.execPath, [CLI, "runtime", "metrics", "summarize", dir], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.schema, "devexec.local-run-record/v1");
  assert.equal(parsed.count, 0);
});

test("recovery scan is read-only and exposed through the public dispatcher", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-recovery-scan-"));
  const journal = createRecoveryJournal({ stateDir, runId: "cli-scan" }); journal.append("PREFLIGHT");
  const before = fs.readdirSync(path.join(stateDir, "cli-scan")).sort();
  const result = spawnSync(process.execPath, [CLI, "runtime", "recovery", "scan", "--state-dir", stateDir], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.runs[0].classification, "NONTERMINAL");
  assert.deepEqual(fs.readdirSync(path.join(stateDir, "cli-scan")).sort(), before);
});
