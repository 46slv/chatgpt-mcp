import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const adapter = path.join(here, "local-worker-adapter.mjs");

function writeState(base, requestedId, overrides = {}) {
  const dir = path.join(base, "ChatGPTMCPProbe", "local-worker-runs");
  fs.mkdirSync(dir, { recursive: true });
  const value = { protocol: "devexec.local-worker", schema_version: 1, run_id: requestedId, status: "BLOCKED", backend: "test", model: "test", ...overrides };
  fs.writeFileSync(path.join(dir, `${requestedId}.json`), JSON.stringify(value), "utf8");
}

function runStatus(base, id) {
  return spawnSync(process.execPath, [adapter, "status", id], { cwd: path.dirname(here), env: { ...process.env, LOCALAPPDATA: base }, encoding: "utf8", windowsHide: true });
}
test("local worker status accepts the exact persisted execution identity", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dev002-state-"));
  try { writeState(base, "LW-EXACT"); const r = runStatus(base, "LW-EXACT"); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /"run_id": "LW-EXACT"/); }
  finally { fs.rmSync(base, { recursive: true, force: true }); }
});

for (const [name, overrides] of [
  ["run_id mismatch", { run_id: "LW-OTHER" }],
  ["protocol mismatch", { protocol: "wrong.protocol" }],
  ["schema mismatch", { schema_version: 2 }],
]) test(`local worker status fails closed on ${name}`, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dev002-state-"));
  try { writeState(base, "LW-EXACT", overrides); const r = runStatus(base, "LW-EXACT"); assert.equal(r.status, 2); assert.match(r.stderr, /local worker state identity mismatch/); }
  finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("local worker status fails closed on malformed persisted JSON", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dev002-state-"));
  try { const dir = path.join(base, "ChatGPTMCPProbe", "local-worker-runs"); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "LW-EXACT.json"), "{", "utf8"); const r = runStatus(base, "LW-EXACT"); assert.equal(r.status, 2); }
  finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("local worker stop cannot redirect a mismatched state into another session", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dev002-state-"));
  try { writeState(base, "LW-EXACT", { run_id: "LW-OTHER", status: "RUNNING" }); const r = spawnSync(process.execPath, [adapter, "stop", "LW-EXACT"], { cwd: path.dirname(here), env: { ...process.env, LOCALAPPDATA: base }, encoding: "utf8", windowsHide: true }); assert.equal(r.status, 2); assert.equal(fs.existsSync(path.join(base, "ChatGPTMCPProbe", "local-worker-runs", "LW-OTHER.json")), false); }
  finally { fs.rmSync(base, { recursive: true, force: true }); }
});
