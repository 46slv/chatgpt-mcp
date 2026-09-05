import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isValidRunId, listRuns, listTargets, readStepFile, runDetail } from "./devexec-native-console.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE = path.join(here, "devexec-native-console.mjs");
const GOOD_URL = "https://chatgpt.com/c/6a9ba452-8b64-83e8-a7f6-e5704521360b";

function setupFixtures() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-console-"));
  const local = path.join(root, "local");
  const stateDir = path.join(local, "ChatGPTMCPProbe", "dev-exec-state");
  const runsDir = path.join(local, "ChatGPTMCPProbe", "dev-exec-runs");
  fs.mkdirSync(path.join(local, "DevExec"), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(runsDir, "RUN-GOOD"), { recursive: true });
  fs.writeFileSync(path.join(local, "DevExec", "targets.json"), JSON.stringify({
    schema_version: 1,
    default_target: "good",
    targets: {
      good: { transport: "chatgpt-web", title: "Good", chat_url: GOOD_URL, conversation_id: "6a9ba452-8b64-83e8-a7f6-e5704521360b" },
      broken: { transport: "chatgpt-web", title: "Broken", chat_url: "https://chatgpt.com/c/not a url!!" },
    },
  }), "utf8");
  const goodState = {
    protocol: "dev-exec.state", schema_version: 1, run_id: "RUN-GOOD",
    parent_run_id: null, phase: "COMPLETE", step: 1, pending: null,
    last_result: { step: 1, exitCode: 0, timedOut: false, workingDirectory: "C:\\iso\\probe", durationMs: 12 },
    target: { target_id: "good", chat_url: GOOD_URL },
    stop_reason: "done",
  };
  fs.writeFileSync(path.join(stateDir, "RUN-GOOD.json"), JSON.stringify(goodState), "utf8");
  fs.writeFileSync(path.join(stateDir, "RUN-BAD.json"), "not json{{{", "utf8");
  const runDir = path.join(runsDir, "RUN-GOOD");
  fs.writeFileSync(path.join(runDir, "events.jsonl"), JSON.stringify({ phase: "INIT" }) + "\nnot-json-line\n" + JSON.stringify({ phase: "COMPLETE" }) + "\n", "utf8");
  fs.writeFileSync(path.join(runDir, "step-001.ps1"), "Get-Date\n", "utf8");
  fs.writeFileSync(path.join(runDir, "step-001.stdout.txt"), "ok\n", "utf8");
  fs.writeFileSync(path.join(runDir, "step-001.stderr.txt"), "", "utf8");
  fs.writeFileSync(path.join(runDir, "step-001.result.json"), JSON.stringify({ step: 1 }), "utf8");
  fs.writeFileSync(path.join(runDir, "step-001.receipt.json"), JSON.stringify({ step: 1 }), "utf8");
  fs.writeFileSync(path.join(runDir, "self-recovery.jsonl"), JSON.stringify({ depth: 0 }) + "\n", "utf8");
  fs.writeFileSync(path.join(runDir, "stop-alert.json"), JSON.stringify({ alert: false }), "utf8");
  fs.writeFileSync(path.join(stateDir, "RUN-BIG.json"), JSON.stringify({ ...goodState, run_id: "RUN-BIG", phase: "STEP_PASS" }), "utf8");
  fs.mkdirSync(path.join(runsDir, "RUN-BIG"), { recursive: true });
  fs.writeFileSync(path.join(runsDir, "RUN-BIG", "step-001.stdout.txt"), "x".repeat(70000), "utf8");
  return { root, local, stateDir, runsDir, env: { LOCALAPPDATA: local } };
}

function hashTree(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex"));
    }
  };
  walk(dir);
  return out.join(",");
}

function rawRequest(port, target, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: target, method, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function startServer(env, port) {
  const child = spawn(process.execPath, [CONSOLE, "--port", String(port)], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/runs`);
      if (res.ok) break;
    } catch {}
    if (Date.now() > deadline) {
      child.kill("SIGTERM");
      throw new Error("console server did not start");
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return child;
}

async function stopServer(child) {
  child.kill("SIGTERM");
  await new Promise((resolve) => { child.on("exit", resolve); setTimeout(resolve, 5000); });
}

test("targets list keeps valid rows and isolates the broken entry", () => {
  const { env } = setupFixtures();
  const model = listTargets(env);
  assert.equal(model.default_target, "good");
  assert.equal(model.default_invalid, null);
  const good = model.targets.find((t) => t.alias === "good");
  assert.equal(good.valid, true);
  assert.equal(good.conversation_id, "6a9ba452-8b64-83e8-a7f6-e5704521360b");
  const broken = model.targets.find((t) => t.alias === "broken");
  assert.equal(broken.valid, false);
  assert.equal(broken.code, "TARGET_ENTRY_INVALID");
  assert.ok(broken.error.length > 0);
});

test("runs list shows known fixtures and never crashes on malformed state", () => {
  const { env } = setupFixtures();
  const model = listRuns(env);
  const good = model.runs.find((r) => r.run_id === "RUN-GOOD");
  assert.equal(good.phase, "COMPLETE");
  assert.equal(good.step, 1);
  assert.equal(good.pending, false);
  assert.equal(good.target_id, "good");
  assert.equal(good.working_directory, "C:\\iso\\probe");
  assert.equal(good.terminal, true);
  assert.deepEqual(good.last_result, { step: 1, exit_code: 0, timed_out: false, duration_ms: 12 });
  const bad = model.runs.find((r) => r.run_id === "RUN-BAD");
  assert.equal(bad.phase, "UNREADABLE");
});

test("run detail exposes evidence without crashing", () => {
  const { env } = setupFixtures();
  const detail = runDetail("RUN-GOOD", env);
  assert.equal(detail.summary.run_id, "RUN-GOOD");
  assert.equal(detail.events.length, 3);
  assert.ok(detail.events[1].unparsed);
  assert.ok(detail.steps.some((s) => s.file === "step-001.stdout.txt" && s.size === 3));
  assert.equal(detail.self_recovery.length, 1);
  assert.deepEqual(detail.stop_alert, { alert: false });
});

test("unknown and unsafe run ids fail closed", () => {
  const { env } = setupFixtures();
  assert.equal(isValidRunId("../evil"), false);
  assert.equal(isValidRunId("RUN-GOOD"), true);
  assert.rejects(async () => runDetail("RUN-NOPE", env), (e) => e.status === 404);
  assert.rejects(async () => runDetail("../evil", env), (e) => e.status === 400);
  assert.rejects(async () => readStepFile("RUN-GOOD", "1", "exe", env), (e) => e.status === 400);
  assert.rejects(async () => readStepFile("RUN-GOOD", "999", "stdout", env), (e) => e.status === 404);
});

test("oversized step files are bounded with a truncation flag", () => {
  const { env } = setupFixtures();
  const small = readStepFile("RUN-GOOD", "1", "stdout", env);
  assert.equal(small.truncated, false);
  assert.equal(small.content, "ok\n");
  const big = readStepFile("RUN-BIG", "1", "stdout", env);
  assert.equal(big.truncated, true);
  assert.ok(big.content.length <= 65536);
});

test("read model is stable across restarts and mutates nothing", () => {
  const { root, env } = setupFixtures();
  const before = hashTree(root);
  const first = { targets: listTargets(env), runs: listRuns(env), detail: runDetail("RUN-GOOD", env) };
  const second = { targets: listTargets(env), runs: listRuns(env), detail: runDetail("RUN-GOOD", env) };
  assert.deepEqual(second, first);
  assert.equal(hashTree(root), before);
});

test("server serves UI and JSON, guards foreign Host and Origin", async () => {
  const { env } = setupFixtures();
  const port = 43291;
  const child = await startServer(env, port);
  try {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes("Native Dev Exec Console"));
    const targets = await (await fetch(`http://127.0.0.1:${port}/api/targets`)).json();
    assert.ok(targets.targets.some((t) => t.alias === "good" && t.valid));
    assert.ok(targets.targets.some((t) => t.alias === "broken" && !t.valid));
    const runs = await (await fetch(`http://127.0.0.1:${port}/api/runs`)).json();
    assert.ok(runs.runs.some((r) => r.run_id === "RUN-GOOD" && r.phase === "COMPLETE"));
    const step = await (await fetch(`http://127.0.0.1:${port}/api/runs/RUN-GOOD/step/001/stdout`)).json();
    assert.equal(step.content, "ok\n");
    const foreignHost = await rawRequest(port, "/api/runs", { headers: { host: "evil.example" } });
    assert.equal(foreignHost.status, 403);
    const foreignOrigin = await rawRequest(port, "/api/runs", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json", "content-length": "2" } });
    assert.equal(foreignOrigin.status, 403);
    const traversal = await rawRequest(port, "/api/runs/..%2Fevil");
    assert.equal(traversal.status, 400);
    const unknown = await rawRequest(port, "/api/runs/RUN-NOPE");
    assert.equal(unknown.status, 404);
  } finally {
    await stopServer(child);
  }
});
