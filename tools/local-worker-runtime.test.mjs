import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  captureGitEvidence,
  createTaskContract,
  killProcessTree,
  normalizeTestCommand,
  redactStructuredLog,
  runLocalWorkerTask,
  validateTaskBoundary,
} from "./local-worker-runtime.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-local-runtime-"));
  fs.writeFileSync(path.join(root, "README.md"), "fixture\n", "utf8");
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "DevExec Test"]);
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "fixture"]);
  const base = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const task = createTaskContract({
    task_id: "phase1-fixture",
    repo: root,
    worktree: root,
    base_commit: base,
    goal: "make a bounded fixture edit",
    allowed_paths: ["src/value.txt"],
    constraints: ["do not commit"],
    test_command: [process.execPath, "-e", "process.stdout.write('ok')"],
    timeout: 30000,
    max_tool_calls: 8,
    output_limit: 4000,
  });
  return { root, task };
}

test("task contract rejects shell syntax and normalizes argv", () => {
  assert.deepEqual(normalizeTestCommand([process.execPath, "-e", "process.stdout.write('ok')"]), [process.execPath, "-e", "process.stdout.write('ok')"]);
  assert.throws(() => normalizeTestCommand("npm test; git commit -am x"), /forbidden|denied/i);
});

test("parent boundary validates exact Git root and base HEAD", () => {
  const { root, task } = fixture();
  const boundary = validateTaskBoundary(task);
  assert.equal(boundary.git_root, path.resolve(root));
  assert.equal(boundary.base_matches_head, true);
  assert.deepEqual(captureGitEvidence(root).changed_paths, []);
  assert.throws(() => validateTaskBoundary({ ...task, cwd: os.tmpdir() }), /cwd|inside/i);
});

test("parent rejects symlink/reparse allowed paths", (t) => {
  const { root, task } = fixture();
  const target = path.join(root, "linked");
  try { fs.symlinkSync(os.tmpdir(), target, "junction"); } catch { t.skip("symlink creation is unavailable on this host"); return; }
  const unsafe = { ...task, allowed_paths: ["linked/file.txt"] };
  assert.throws(() => validateTaskBoundary(unsafe), /symlink|reparse/i);
});

test("parent recomputes allowed edits and ignores worker claims", async () => {
  const { root, task } = fixture();
  const outcome = await runLocalWorkerTask(task, {
    adapter: { identity: { runtime: "local", provider: "fake", token: "secret" }, async run() { fs.mkdirSync(path.join(root, "src")); fs.writeFileSync(path.join(root, "src/value.txt"), "1\n"); return { status: "PASS", changed_files: ["wrong.txt"] }; } },
  });
  assert.equal(outcome.result.status, "DONE");
  assert.deepEqual(outcome.result.changed_files, ["src/value.txt"]);
  assert.equal(outcome.result.safety_metrics.result_claim_trusted, false);
  assert.equal(outcome.log.runtime_provider_identity.token, "[REDACTED]");
});

test("scope escape is blocked even when adapter reports success", async () => {
  const { root, task } = fixture();
  const outcome = await runLocalWorkerTask(task, {
    adapter: { identity: { runtime: "local", provider: "fake" }, async run() { fs.writeFileSync(path.join(root, "outside.txt"), "nope\n"); return { status: "PASS" }; } },
  });
  assert.equal(outcome.result.status, "BLOCKED");
  assert.match(outcome.result.blocker, /unexpected changed paths/);
});

test("worker commit and malformed result are fail-closed", async () => {
  const { root, task } = fixture();
  const outcome = await runLocalWorkerTask(task, {
    adapter: { identity: { runtime: "local", provider: "fake" }, async run() { fs.writeFileSync(path.join(root, "src.txt"), "x\n"); execFileSync("git", ["-C", root, "add", "src.txt"]); execFileSync("git", ["-C", root, "-c", "user.email=test@example.invalid", "-c", "user.name=worker", "commit", "-q", "-m", "bad"]); return null; } },
  });
  assert.equal(outcome.result.status, "BLOCKED");
  assert.equal(outcome.result.safety_metrics.commit_detected, true);
});

test("process-tree cleanup and structured log are bounded", () => {
  let killed = null;
  assert.equal(killProcessTree({ pid: 123 }, { platform: "win32", taskkill: (pid) => { killed = pid; } }), true);
  assert.equal(killed, 123);
  const redacted = redactStructuredLog({ env: { API_KEY: "secret" }, source: "x".repeat(2000) });
  assert.equal(redacted.env, "[REDACTED]");
  assert.match(redacted.source, /TRUNCATED/);
});
