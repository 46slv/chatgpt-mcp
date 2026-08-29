import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import test from "node:test";

test("target verification reports the selected CDP target id", async () => {
  const {verifyTarget} = await import("./target-verify.mjs");
  const previousFetch = globalThis.fetch;
  const previousWebSocket = globalThis.WebSocket;
  class FakeWebSocket {
    constructor(url) { this.url = url; this.listeners = {}; queueMicrotask(() => { for (const fn of this.listeners.open || []) fn(); }); }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    send() {
      const message = {id: 1, result: {result: {value: JSON.stringify({href: "https://chatgpt.com/c/abc", title: "T", visibility: "visible", focused: true})}}};
      for (const fn of this.listeners.message || []) fn({data: JSON.stringify(message)});
    }
    close() {}
  }
  globalThis.fetch = async () => ({ok: true, json: async () => [{id: "cdp-42", type: "page", url: "https://chatgpt.com/c/abc", webSocketDebuggerUrl: "ws://fake"}]});
  globalThis.WebSocket = FakeWebSocket;
  try {
    const result = await verifyTarget("main", {registry: {targets: {main: {transport: "chatgpt-web", chat_url: "https://chatgpt.com/c/abc"}}}});
    assert.equal(result.browser_target_id, "cdp-42");
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.WebSocket = previousWebSocket;
  }
});

test("goal dry-run does not start a worker or write durable state", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-dry-run-"));
  const result = spawnSync(process.execPath, ["tools/devexec-goal.mjs", "--dry-run", "audit safely"], {cwd: path.resolve("."), env: {...process.env, LOCALAPPDATA: base, LOCAL_WORKER_LMS: "definitely-not-invoked"}, encoding: "utf8"});
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.decision, "DRY_RUN");
  assert.equal(payload.worker_started, false);
  assert.equal(payload.durable_state_written, false);
  assert.equal(fs.existsSync(path.join(base, "ChatGPTMCPProbe")), false);
  fs.rmSync(base, {recursive: true, force: true});
});

test("unsafe ids are rejected before path construction", async () => {
  const {checkpointPath} = await import("./local-worker-session-checkpoint.mjs");
  for (const value of ["../escape", "LW-..-x", "C:\\escape", "/absolute"]) {
    assert.throws(() => checkpointPath(os.tmpdir(), value), /invalid checkpoint target/);
  }
  const result = spawnSync(process.execPath, ["tools/local-agent-facade.mjs", "status", "../escape"], {cwd: path.resolve("."), env: {...process.env, LOCALAPPDATA: fs.mkdtempSync(path.join(os.tmpdir(), "devexec-agent-"))}, encoding: "utf8"});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid local agent run id|Error/);
});

test("supervisor read_file repair args are exact and bounded", async () => {
  const {validateLocalWorkerRepair} = await import("./local-worker-supervisor-repair.mjs");
  const worker = {run_id: "LW-1", actions: []};
  const base = {protocol: "devexec.local-worker-repair", schema_version: 1, worker_run_id: "LW-1", expected_action_count: 0, mode: "EXECUTE_TYPED_ACTIONS"};
  assert.throws(() => validateLocalWorkerRepair({...base, next_actions: [{action: "read_file", args: {path: "x", extra: "no"}}]}, worker), /invalid typed repair action/);
  assert.doesNotThrow(() => validateLocalWorkerRepair({...base, next_actions: [{action: "read_file", args: {path: "x", max_bytes: 10}}]}, worker));
  assert.throws(() => validateLocalWorkerRepair({...base, next_actions: [{action: "read_file", args: {path: "x", max_bytes: 999999}}]}, worker), /invalid typed repair action/);
});
