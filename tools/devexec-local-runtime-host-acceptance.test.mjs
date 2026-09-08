import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { classifyHostAcceptance, runProbe } from "./devexec-local-runtime-host-acceptance.mjs";

const C = "a".repeat(40);
const S = "b".repeat(40);
const cleanBefore = { port: { status: "FREE" }, control: { status: "STOPPED" }, process: null };
const cleanAfter = { port: { status: "FREE" }, control: { status: "STOPPED" }, process: null };
function classify(overrides = {}) {
  return classifyHostAcceptance({ observedConsumerSha: C, expectedConsumerSha: C, bindingSha: S, expectedSystemSha: S, externalPid: null, before: cleanBefore, after: cleanAfter, cliExitCode: 0, cliStatus: "DONE", ...overrides });
}

test("identity gates block before host acceptance", () => {
  assert.equal(classify({ observedConsumerSha: "c".repeat(40) }).code, "CONSUMER_SHA_MISMATCH");
  assert.equal(classify({ bindingSha: "d".repeat(40) }).code, "BINDING_SHA_MISMATCH");
});

test("owned preconditions are fail-closed", () => {
  assert.equal(classify({ before: { port: { status: "AMBIGUOUS" }, control: { status: "STOPPED" } } }).code, "OWNED_PRECONDITION_AMBIGUOUS");
  assert.equal(classify({ before: { port: { status: "LISTENING", pid: 9 }, control: { status: "STOPPED" } } }).code, "UNDECLARED_EXTERNAL_RUNTIME_PRESENT");
  assert.equal(classify({ before: { port: { status: "FREE" }, control: { status: "RUNNING" } } }).code, "OWNED_PRECONDITION_NOT_STOPPED");
});

test("owned cleanup terminal matrix distinguishes port, engine, ambiguity, CLI failure, and PASS", () => {
  assert.equal(classify({ after: { port: { status: "LISTENING", pid: 9 }, control: { status: "RUNNING" } } }).code, "OWNED_PORT_SURVIVED");
  assert.equal(classify({ after: { port: { status: "FREE" }, control: { status: "RUNNING" } } }).code, "OWNED_ENGINE_SURVIVED");
  assert.equal(classify({ after: { port: { status: "AMBIGUOUS" }, control: { status: "STOPPED" } } }).code, "POST_PORT_AMBIGUOUS");
  assert.equal(classify({ after: { port: { status: "FREE" }, control: { status: "AMBIGUOUS" } } }).code, "POST_CONTROL_AMBIGUOUS");
  assert.equal(classify({ cliExitCode: 1, cliStatus: "FAILED" }).code, "CLI_NOT_DONE_AFTER_CLEANUP");
  assert.deepEqual(classify(), { status: "PASS", code: "PASS_OWNED_CLEANUP" });
});

test("external precondition requires exact live process and listening port owner", () => {
  const externalPid = 77;
  const before = { port: { status: "LISTENING", pid: externalPid }, process: { status: "MISSING", pid: externalPid }, control: { status: "AMBIGUOUS" } };
  assert.equal(classify({ externalPid, before, after: before }).code, "EXTERNAL_PRECONDITION_UNPROVEN");
});

test("external runtime identity and listener must remain unchanged even on CLI failure", () => {
  const externalPid = 77;
  const before = { port: { status: "LISTENING", pid: externalPid }, process: { status: "LIVE", pid: externalPid, start_time_utc: "2026-09-08T00:00:00.000Z" }, control: { status: "AMBIGUOUS" } };
  const changedProcess = { ...before, process: { ...before.process, start_time_utc: "2026-09-08T00:01:00.000Z" } };
  const changedPort = { ...before, port: { status: "FREE" } };
  assert.equal(classify({ externalPid, before, after: changedProcess }).code, "EXTERNAL_RUNTIME_CHANGED");
  assert.equal(classify({ externalPid, before, after: changedPort }).code, "EXTERNAL_RUNTIME_CHANGED");
  assert.equal(classify({ externalPid, before, after: before, cliExitCode: 1, cliStatus: "FAILED" }).code, "CLI_NOT_DONE_EXTERNAL_PRESERVED");
  assert.deepEqual(classify({ externalPid, before, after: before }), { status: "PASS", code: "PASS_EXTERNAL_UNCHANGED" });
});


test("actual probe binding gate stops before Windows/provider/CLI work", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dev002-host-gate-"));
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "dev002-host-cache-"));
  try {
    fs.mkdirSync(path.join(root, "tools"), { recursive: true });
    fs.writeFileSync(path.join(root, "tools", "ephemera-runtime-binding.mjs"), `export const EPHEMERA_RUNTIME_BINDING={target_commit_sha:${JSON.stringify("0".repeat(40))}}; export function validateEphemeraRuntimeBinding(v){return v;}\n`, "utf8");
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
    execFileSync("git", ["-C", root, "config", "user.name", "Host Probe Test"]);
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", ["-C", root, "commit", "-q", "-m", "fixture"]);
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim().toLowerCase();
    const result = await runProbe({ repoRoot: root, expectedConsumerSha: head, expectedSystemSha: "f".repeat(40), model: "model.gguf", modelPath: "model.gguf", cacheDir: cache, controlUrl: "http://127.0.0.1:1900", serveUrl: "http://127.0.0.1:1919", externalPid: null, timeoutMs: 1000 });
    assert.equal(result.code, "BINDING_SHA_MISMATCH");
    assert.equal(result.cli_attempted, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(cache, { recursive: true, force: true });
  }
});
