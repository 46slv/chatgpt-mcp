import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { continueRun, createConsoleServer, createControlStore, isValidRunId, listRuns, listTargets, readStepFile, runDetail, runRecovery, startRun, stopRun } from "./devexec-native-console.mjs";

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
      good2: { transport: "chatgpt-web", title: "Good 2", chat_url: GOOD_URL, conversation_id: "6a9ba452-8b64-83e8-a7f6-e5704521360b" },
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
  const terminalParent = { protocol: "dev-exec.state", schema_version: 1, run_id: "RUN-GOOD", phase: "COMPLETE" };
  void terminalParent;
  const active = { protocol: "dev-exec.state", schema_version: 1, run_id: "RUN-ACTIVE", parent_run_id: null, phase: "SUPERVISOR_ROUND_1_IN_FLIGHT", step: 0, pending: null, last_result: null, target: { target_id: "good", chat_url: GOOD_URL } };
  fs.writeFileSync(path.join(stateDir, "RUN-ACTIVE.json"), JSON.stringify(active), "utf8");
  const pend = { protocol: "dev-exec.state", schema_version: 1, run_id: "RUN-PEND", parent_run_id: null, phase: "COMPLETE", step: 1, pending: { step: 1, working_directory: "C:\\x", timeout_seconds: 60, script_sha256: "a", script: "x", accepted_at: "2026-09-06T00:00:00.000Z" }, last_result: null, target: { target_id: "good", chat_url: GOOD_URL } };
  fs.writeFileSync(path.join(stateDir, "RUN-PEND.json"), JSON.stringify(pend), "utf8");
  const badt = { protocol: "dev-exec.state", schema_version: 1, run_id: "RUN-BADTARGET", parent_run_id: null, phase: "COMPLETE", step: 0, pending: null, last_result: null, target: { target_id: "broken", chat_url: "https://chatgpt.com/c/old" } };
  fs.writeFileSync(path.join(stateDir, "RUN-BADTARGET.json"), JSON.stringify(badt), "utf8");
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

test("served inline script parses without SyntaxError (escaped newline)", async () => {
  const { env } = setupFixtures();
  const server = createConsoleServer({ env });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    const match = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(match, "inline script found");
    const code = match[1];
    assert.ok(code.includes('.join("\\n")'), "served script keeps literal backslash-n");
    assert.ok(!code.includes('.join("\n")'), "served script has no raw-newline join");
    new vm.Script(code);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function freshChild(log) {
  const child = {
    pid: 4242 + log.length,
    killed: [],
    killResult: true,
    handlers: {},
    stdout: { on() {} },
    stderr: { on() {} },
    on(ev, fn) { child.handlers[ev] = fn; },
    kill(sig) { child.killed.push(sig); return child.killResult !== false; },
  };
  return child;
}

function makeSpawn(log) {
  const children = [];
  const fn = (cmd, args, opts) => {
    const child = freshChild(log);
    children.push(child);
    log.push({ cmd, args, opts });
    return child;
  };
  fn.children = children;
  Object.defineProperty(fn, "child", { get() { return children[children.length - 1]; } });
  return fn;
}

function exitChild(spawnFn, code = 0, index = 0) {
  spawnFn.children[index].handlers.exit(code, null);
}

test("launch records exact spawn identity and returns the run id", () => {
  const { env } = setupFixtures();
  const controls = createControlStore();
  const log = [];
  const spawnFn = makeSpawn(log);
  const record = startRun({ targetAlias: "good", purpose: "canary goal", controls, spawnFn, env });
  assert.match(record.run_id, /^CONSOLE-[0-9]+-[0-9a-f]+$/);
  assert.equal(record.target_alias, "good");
  assert.equal(record.pid, 4242);
  assert.equal(record.status, "RUNNING");
  assert.equal(record.owned_by_console, true);
  assert.equal(log.length, 1);
  assert.ok(log[0].cmd.endsWith("node") || log[0].cmd.endsWith("node.exe"));
  assert.deepEqual(log[0].args.slice(1), ["run", "--target", "good"]);
  assert.ok(log[0].args[0].endsWith("devexec.mjs"));
  assert.equal(log[0].opts.env.DEV_EXEC_TARGET_ALIAS, "good");
  assert.equal(log[0].opts.env.DEV_EXEC_PURPOSE, "canary goal");
  assert.equal(log[0].opts.env.DEV_EXEC_RUN_ID, record.run_id);
  assert.equal(controls.get(record.run_id).status, "RUNNING");
});

test("duplicate launch on a running target is refused, relaunch after exit is allowed", () => {
  const { env } = setupFixtures();
  const controls = createControlStore();
  const log = [];
  const spawnFn = makeSpawn(log);
  const first = startRun({ targetAlias: "good", purpose: "one", controls, spawnFn, env });
  assert.throws(() => startRun({ targetAlias: "good", purpose: "two", controls, spawnFn, env }), (e) => e.status === 409 && e.code === "RUN_CONFLICT");
  assert.equal(log.length, 1);
  exitChild(spawnFn, 0);
  assert.equal(controls.get(first.run_id).status, "EXITED");
  const second = startRun({ targetAlias: "good", purpose: "three", controls, spawnFn, env });
  assert.notEqual(second.run_id, first.run_id);
  assert.equal(log.length, 2);
});

test("launch validates target and purpose without spawning", () => {
  const { env } = setupFixtures();
  const controls = createControlStore();
  const log = [];
  const spawnFn = makeSpawn(log);
  assert.throws(() => startRun({ targetAlias: "broken", purpose: "x", controls, spawnFn, env }), (e) => e.status === 400);
  assert.throws(() => startRun({ targetAlias: "../evil", purpose: "x", controls, spawnFn, env }), (e) => e.status === 400);
  assert.throws(() => startRun({ targetAlias: "good", purpose: "  ", controls, spawnFn, env }), (e) => e.status === 400);
  assert.throws(() => startRun({ targetAlias: "good", purpose: "x".repeat(4001), controls, spawnFn, env }), (e) => e.status === 400);
  assert.equal(log.length, 0);
});

test("stop reaches only console-owned running children", () => {
  const { env } = setupFixtures();
  const controls = createControlStore();
  const spawnFn = makeSpawn([]);
  const record = startRun({ targetAlias: "good", purpose: "x", controls, spawnFn, env });
  const stopped = stopRun(record.run_id, { controls });
  assert.equal(stopped.status, "STOP_REQUESTED");
  assert.deepEqual(spawnFn.child.killed, ["SIGTERM"]);
  assert.throws(() => stopRun("RUN-NOPE", { controls }), (e) => e.status === 400);
  exitChild(spawnFn, 0);
  assert.throws(() => stopRun(record.run_id, { controls }), (e) => e.status === 400);
  const controls2 = createControlStore();
  const spawnFn2 = makeSpawn([]);
  const record2 = startRun({ targetAlias: "good", purpose: "x", controls: controls2, spawnFn: spawnFn2, env });
  spawnFn2.children[0].killResult = false;
  assert.throws(() => stopRun(record2.run_id, { controls: controls2 }), (e) => e.status === 500);
});

async function startLocalServer(t, { env, controls, spawnFn, port }) {
  const { createConsoleServer: create } = await import("./devexec-native-console.mjs");
  const server = create({ controls, spawnFn, env });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server;
}

test("server launch/stop APIs enforce ownership and conflicts", async (t) => {
  const { env } = setupFixtures();
  const controls = createControlStore();
  const log = [];
  const spawnFn = makeSpawn(log);
  await startLocalServer(t, { env, controls, spawnFn, port: 43293 });
  const post = (target, body, headers) => fetch(`http://127.0.0.1:43293${target}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(headers || {}) },
    body: JSON.stringify(body || {}),
  });
  let res = await post("/api/runs", { target_alias: "good", purpose: "api goal" });
  assert.equal(res.status, 200);
  const launched = await res.json();
  assert.match(launched.run_id, /^CONSOLE-/);
  assert.equal(log.length, 1);
  res = await post("/api/runs", { target_alias: "good", purpose: "again" });
  assert.equal(res.status, 409);
  res = await post("/api/runs", { target_alias: "broken", purpose: "x" });
  assert.equal(res.status, 400);
  res = await post("/api/runs", { target_alias: "good" });
  assert.equal(res.status, 400);
  const controlsRes = await fetch("http://127.0.0.1:43293/api/controls");
  assert.equal(controlsRes.status, 200);
  const listed = (await controlsRes.json()).controls;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].owned_by_console, true);
  res = await post(`/api/runs/${launched.run_id}/stop`, {});
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "STOP_REQUESTED");
  res = await post("/api/runs/RUN-NOPE/stop", {});
  assert.equal(res.status, 400);
  res = await post("/api/runs", { target_alias: "good", purpose: "x" }, { origin: "https://evil.example" });
  assert.equal(res.status, 403);
});

test("continue validates parent state without spawning", () => {
  const { env } = setupFixtures();
  const controls = createControlStore();
  const spawnFn = makeSpawn([]);
  assert.rejects(async () => continueRun({ parentRunId: "RUN-NOPE", controls, spawnFn, env }), (e) => e.status === 404);
  assert.rejects(async () => continueRun({ parentRunId: "RUN-ACTIVE", controls, spawnFn, env }), (e) => e.status === 400 && e.code === "RUN_NOT_TERMINAL");
  assert.rejects(async () => continueRun({ parentRunId: "RUN-PEND", controls, spawnFn, env }), (e) => e.status === 400 && e.code === "RUN_PENDING_BLOCKED");
  assert.rejects(async () => continueRun({ parentRunId: "RUN-BADTARGET", controls, spawnFn, env }), (e) => e.status === 400 && e.code === "TARGET_ENTRY_INVALID");
  assert.rejects(async () => continueRun({ parentRunId: "RUN-BAD", controls, spawnFn, env }), (e) => e.status === 400);
});

test("continue spawns the child with lineage and the exact parent target", () => {
  const { env } = setupFixtures();
  const controls = createControlStore();
  const log = [];
  const spawnFn = makeSpawn(log);
  const rec = continueRun({ parentRunId: "RUN-GOOD", controls, spawnFn, env });
  assert.match(rec.run_id, /^CONSOLE-CONTINUE-[0-9]+-[0-9a-f]+$/);
  assert.equal(rec.kind, "continue");
  assert.equal(rec.parent_run_id, "RUN-GOOD");
  assert.equal(rec.target_alias, "good");
  assert.equal(rec.status, "RUNNING");
  assert.equal(log.length, 1);
  assert.deepEqual(log[0].args.slice(1), ["continue", "RUN-GOOD", "--target", "good"]);
  assert.equal(log[0].opts.env.DEV_EXEC_CONTINUE_RUN_ID, rec.run_id);
  assert.throws(() => continueRun({ parentRunId: "RUN-GOOD", controls, spawnFn, env }), (e) => e.status === 409);
  assert.equal(log.length, 1);
});

test("recovery inspect and verify run the source CLI on fixtures", () => {
  const { env } = setupFixtures();
  const inspect = runRecovery("RUN-GOOD", "inspect", { env });
  assert.equal(inspect.exit_code, 0);
  assert.equal(typeof inspect.result, "object");
  const verify = runRecovery("RUN-GOOD", "verify-journal", { env });
  assert.ok(verify.exit_code === 0 || verify.exit_code === 3);
  assert.equal(typeof verify.result.valid, "boolean");
  assert.throws(() => runRecovery("RUN-GOOD", "reconcile", { env }), (e) => e.status === 400 && e.code === "RECONCILE_DISABLED");
  assert.throws(() => runRecovery("RUN-GOOD", "nope", { env }), (e) => e.status === 400);
  assert.throws(() => runRecovery("../evil", "inspect", { env }), (e) => e.status === 400);
});

test("server continue and recovery routes", async (t) => {
  const { env } = setupFixtures();
  const controls = createControlStore();
  const spawnFn = makeSpawn([]);
  await startLocalServer(t, { env, controls, spawnFn, port: 43294 });
  const post = (target, body) => fetch(`http://127.0.0.1:43294${target}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  let res = await post("/api/runs/RUN-NOPE/continue", {});
  assert.equal(res.status, 404);
  res = await post("/api/runs/RUN-ACTIVE/continue", {});
  assert.equal(res.status, 400);
  res = await post("/api/runs/RUN-GOOD/continue", {});
  assert.equal(res.status, 200);
  const child = await res.json();
  assert.equal(child.parent_run_id, "RUN-GOOD");
  assert.equal(child.kind, "continue");
  res = await post("/api/runs/RUN-GOOD/continue", {});
  assert.equal(res.status, 409);
  let get = await fetch("http://127.0.0.1:43294/api/runs/RUN-GOOD/recovery?kind=inspect");
  assert.equal(get.status, 200);
  get = await fetch("http://127.0.0.1:43294/api/runs/RUN-GOOD/recovery?kind=verify-journal");
  assert.equal(get.status, 200);
  get = await fetch("http://127.0.0.1:43294/api/runs/RUN-GOOD/recovery?kind=reconcile");
  assert.equal(get.status, 400);
  assert.equal((await get.json()).error.includes("reconcile"), true);
});

test("concurrent runs on different targets are independent", () => {
  const { env } = setupFixtures();
  const controls = createControlStore();
  const log = [];
  const spawnFn = makeSpawn(log);
  const first = startRun({ targetAlias: "good", purpose: "one", controls, spawnFn, env });
  const second = startRun({ targetAlias: "good2", purpose: "two", controls, spawnFn, env });
  assert.notEqual(first.run_id, second.run_id);
  assert.equal(controls.get(first.run_id).status, "RUNNING");
  assert.equal(controls.get(second.run_id).status, "RUNNING");
  assert.equal(log.length, 2);
  exitChild(spawnFn, 0, 1);
  assert.equal(controls.get(second.run_id).status, "EXITED");
  stopRun(first.run_id, { controls });
  assert.equal(controls.get(first.run_id).status, "STOP_REQUESTED");
  assert.equal(controls.get(second.run_id).status, "EXITED");
});

test("stale and reused ownership records can never stop anything", () => {
  const { env } = setupFixtures();
  const controls = createControlStore();
  const spawnFn = makeSpawn([]);
  const rec = startRun({ targetAlias: "good", purpose: "x", controls, spawnFn, env });
  exitChild(spawnFn, 1);
  assert.equal(controls.get(rec.run_id).status, "EXITED");
  assert.throws(() => stopRun(rec.run_id, { controls }), (e) => e.status === 400);
  assert.deepEqual(spawnFn.child.killed, []);
  assert.throws(() => stopRun("RUN-NEVER-EXISTED", { controls }), (e) => e.status === 400);
});
