import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  RECOVERY_JOURNAL_SCHEMA,
  createRecoveryJournal,
  scanRecoveryState,
  validateRecoveryEvent,
  verifyRecoveryRun,
} from "./local-runtime-recovery-journal.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const digest = "a".repeat(64);
function tempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), "devexec-recovery-journal-")); }
function advance(journal) {
  for (const state of ["LEASE_ACQUIRED", "PROVIDER_STARTED", "INFERENCE", "POSTFLIGHT", "TEST", "CLEANUP", "TERMINAL"]) journal.append(state);
}
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function rehash(event) {
  const unsigned = { ...event }; delete unsigned.event_hash;
  return crypto.createHash("sha256").update(canonical(unsigned)).digest("hex");
}

test("creates an immutable hash-chained lifecycle journal and rejects invalid transitions", () => {
  const root = tempRoot(); const journal = createRecoveryJournal({ stateDir: root, runId: "run-lifecycle-1" });
  assert.equal(journal.readEvents()[0].state, "RUN_CREATED");
  journal.append("PREFLIGHT", { phase: "preflight", attempt: 1, count: 0 });
  assert.throws(() => journal.append("INFERENCE"), /invalid recovery transition/);
  advance({ append: (state) => journal.append(state) });
  const result = journal.verify();
  assert.equal(result.valid, true); assert.equal(result.classification, "OK"); assert.equal(result.terminal_state, "TERMINAL");
  assert.deepEqual(fs.readdirSync(path.join(root, "run-lifecycle-1")).sort(), Array.from({ length: 9 }, (_, i) => `${String(i + 1).padStart(8, "0")}.json`));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "run-lifecycle-1", "00000001.json"), "utf8")).schema, RECOVERY_JOURNAL_SCHEMA);
});

test("failure/cancel cleanup and recovery-only interruption paths are bounded", () => {
  const root = tempRoot();
  const failure = createRecoveryJournal({ stateDir: root, runId: "run-failure" });
  failure.append("PREFLIGHT", { failure_code: "GPU_CONFLICT" }); failure.append("CLEANUP", { result_status: "FAILED" }); failure.append("TERMINAL", { result_status: "FAILED" });
  assert.equal(failure.verify().valid, true);
  const recovery = createRecoveryJournal({ stateDir: root, runId: "run-recovery" });
  recovery.append("INTERRUPTED_UNKNOWN", { classification: "INTERRUPTED" }); recovery.append("NEEDS_ATTENTION", { reason_code: "MANUAL_REVIEW" });
  assert.equal(recovery.verify().valid, true);
  assert.throws(() => recovery.append("CLEANUP"), /invalid recovery transition/);
});

test("privacy-bounded data rejects paths, URLs, prompts, source and raw errors", () => {
  const root = tempRoot(); const journal = createRecoveryJournal({ stateDir: root, runId: "run-privacy" });
  for (const data of [{ prompt: "secret" }, { source: "code" }, { path: "C:/secret" }, { url: "https://example.test" }, { raw_error: "stack" }, { digest: "not-a-digest" }, { count: -1 }]) assert.throws(() => journal.append("PREFLIGHT", data));
});

test("tampering, gaps and malformed files are reported read-only", () => {
  const root = tempRoot(); const journal = createRecoveryJournal({ stateDir: root, runId: "run-integrity" }); journal.append("PREFLIGHT");
  const dir = path.join(root, "run-integrity"); const second = path.join(dir, "00000002.json");
  const event = JSON.parse(fs.readFileSync(second, "utf8")); event.data = { reason_code: "TAMPERED" }; fs.writeFileSync(second, JSON.stringify(event));
  const tampered = verifyRecoveryRun(dir, "run-integrity"); assert.equal(tampered.valid, false); assert.equal(tampered.classification, "MALFORMED");
  fs.rmSync(second); fs.writeFileSync(path.join(dir, "00000003.json"), "{}\n");
  const gap = verifyRecoveryRun(dir, "run-integrity"); assert.equal(gap.valid, false); assert.ok(["MALFORMED", "HASH_GAP"].includes(gap.classification));
  fs.writeFileSync(path.join(dir, "owned.tmp-123"), "partial");
  const scanned = scanRecoveryState(root); assert.equal(scanned.status, "ATTENTION"); assert.equal(fs.existsSync(path.join(dir, "owned.tmp-123")), true);
});

test("scanner classifies nonterminal runs and never mutates state", () => {
  const root = tempRoot(); const journal = createRecoveryJournal({ stateDir: root, runId: "run-open" }); journal.append("PREFLIGHT");
  const before = fs.readdirSync(path.join(root, "run-open")).sort(); const scanned = scanRecoveryState(root); const after = fs.readdirSync(path.join(root, "run-open")).sort();
  assert.equal(scanned.runs[0].classification, "NONTERMINAL"); assert.deepEqual(after, before); assert.equal(scanned.status, "ATTENTION");
  assert.equal(verifyRecoveryRun(path.join(root, "run-open"), "run-open").valid, false);
});

test("concurrent append uses exclusive event creation and has exactly one winner", async () => {
  const root = tempRoot(); const runId = "run-race"; createRecoveryJournal({ stateDir: root, runId });
  const moduleUrl = pathToFileURL(path.join(here, "local-runtime-recovery-journal.mjs")).href;
  const code = `import { createRecoveryJournal } from ${JSON.stringify(moduleUrl)}; try { createRecoveryJournal({stateDir:process.argv[1],runId:process.argv[2]}).append("PREFLIGHT"); process.exit(0); } catch { process.exit(7); }`;
  const child = () => new Promise((resolve) => { const p = spawn(process.execPath, ["--input-type=module", "-e", code, root, runId], { stdio: "ignore" }); p.on("exit", (status) => resolve(status)); });
  const statuses = await Promise.all([child(), child()]); assert.equal(statuses.filter((status) => status === 0).length, 1); assert.equal(statuses.filter((status) => status === 7).length, 1);
  assert.equal(fs.existsSync(path.join(root, runId, "00000002.json")), true); assert.equal(verifyRecoveryRun(path.join(root, runId), runId).valid, false);
});

test("reparse/symlink roots are rejected and event schema is exact", (t) => {
  const root = tempRoot(); const journal = createRecoveryJournal({ stateDir: root, runId: "run-schema" }); const event = journal.readEvents()[0];
  assert.doesNotThrow(() => validateRecoveryEvent(event)); assert.throws(() => validateRecoveryEvent({ ...event, extra: 1 }));
  const link = path.join(root, "link");
  try { fs.symlinkSync(path.join(root, "run-schema"), link, "junction"); } catch { t.skip("symlink creation unavailable"); return; }
  assert.throws(() => createRecoveryJournal({ stateDir: link, runId: "run-x" }), /link|private|directory/i);
});

test("bounded startup scan stops before unbounded run/event traversal", () => {
  const root = tempRoot();
  for (let index = 0; index < 3; index += 1) createRecoveryJournal({ stateDir: root, runId: `run-${index}` });
  assert.equal(scanRecoveryState(root, { maxRuns: 2 }).status, "BOUNDED_SCAN");
  assert.equal(scanRecoveryState(root, { maxEvents: 0 }).runs[0].classification, "BOUNDED_SCAN");
});

test("journal anchors reject same-path root/run replacement and scans do not depend on readdirSync", () => {
  const root = tempRoot();
  const journal = createRecoveryJournal({ stateDir: root, runId: "run-anchor-root" });
  const originalReaddir = fs.readdirSync;
  fs.readdirSync = () => { throw new Error("unbounded readdir is forbidden"); };
  try {
    assert.equal(journal.readEvents().length, 1);
    assert.equal(scanRecoveryState(root).status, "ATTENTION");
  } finally { fs.readdirSync = originalReaddir; }

  const priorRoot = `${root}-prior`;
  fs.renameSync(root, priorRoot); fs.mkdirSync(root);
  assert.throws(() => journal.append("PREFLIGHT"), /unsafe|changed|unavailable/i);

  const secondRoot = tempRoot();
  const second = createRecoveryJournal({ stateDir: secondRoot, runId: "run-anchor-run" });
  const priorRun = `${second.runDir}-prior`;
  fs.renameSync(second.runDir, priorRun); fs.mkdirSync(second.runDir);
  assert.throws(() => second.append("PREFLIGHT"), /unsafe|changed|unavailable/i);
});

test("verifier rejects a valid-hash chain with an invalid transition and forbids terminal append", () => {
  const root = tempRoot(); const journal = createRecoveryJournal({ stateDir: root, runId: "run-transition-integrity" });
  journal.append("PREFLIGHT");
  const dir = path.join(root, "run-transition-integrity");
  const event = JSON.parse(fs.readFileSync(path.join(dir, "00000002.json"), "utf8"));
  event.state = "INFERENCE"; event.event_hash = rehash(event);
  fs.writeFileSync(path.join(dir, "00000002.json"), `${canonical(event)}\n`);
  const result = verifyRecoveryRun(dir, "run-transition-integrity");
  assert.equal(result.valid, false); assert.equal(result.classification, "INVALID_TRANSITION");
  const terminal = createRecoveryJournal({ stateDir: root, runId: "run-terminal-append" });
  terminal.append("TERMINAL");
  assert.throws(() => terminal.append("PREFLIGHT"), /invalid recovery transition/);
});

test("timestamps are strict UTC and nondecreasing across append and verification", () => {
  const root = tempRoot(); const times = [new Date("2026-01-01T00:00:00.000Z"), new Date("2025-12-31T23:59:59.999Z")];
  const journal = createRecoveryJournal({ stateDir: root, runId: "run-clock-order", now: () => times.shift() || new Date("2026-01-01T00:00:00.000Z") });
  assert.throws(() => journal.append("PREFLIGHT"), /timestamp moved backwards/);
  const event = journal.readEvents()[0];
  assert.throws(() => validateRecoveryEvent({ ...event, timestamp: "2026-02-31T00:00:00.000Z" }), /invalid recovery timestamp/);
  assert.throws(() => validateRecoveryEvent({ ...event, timestamp: "2026-01-01T00:00:00+00:00" }), /invalid recovery timestamp/);
  const ordered = createRecoveryJournal({ stateDir: root, runId: "run-clock-tamper", now: () => new Date("2026-01-01T00:00:00.000Z") });
  ordered.append("PREFLIGHT");
  const secondPath = path.join(root, "run-clock-tamper", "00000002.json");
  const second = JSON.parse(fs.readFileSync(secondPath, "utf8"));
  second.timestamp = "2025-12-31T23:59:59.999Z"; second.event_hash = rehash(second);
  fs.writeFileSync(secondPath, `${canonical(second)}\n`);
  assert.equal(verifyRecoveryRun(path.join(root, "run-clock-tamper"), "run-clock-tamper").classification, "TIMESTAMP_ORDER");
});

test("scanner reports unsafe, linked, empty, temp-only, and malformed entries without echoing names", (t) => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, "empty-run"));
  fs.mkdirSync(path.join(root, "temp-run")); fs.writeFileSync(path.join(root, "temp-run", "owned.tmp-1"), "partial");
  fs.mkdirSync(path.join(root, "malformed-run")); fs.writeFileSync(path.join(root, "malformed-run", "notes.txt"), "unexpected");
  fs.writeFileSync(path.join(root, "unsafe name"), "not a run");
  const linked = path.join(root, "linked-run");
  try { fs.symlinkSync(path.join(root, "empty-run"), linked, process.platform === "win32" ? "junction" : "dir"); }
  catch { t.skip("symlink creation unavailable"); return; }
  const result = scanRecoveryState(root);
  assert.equal(result.status, "ATTENTION");
  assert.ok(result.runs.every((run) => run.classification === "NEEDS_ATTENTION"));
  assert.ok(result.runs.some((run) => run.reason_code === "UNSAFE_RUN_ID"));
  assert.ok(result.runs.some((run) => run.reason_code === "EMPTY_RUN_DIRECTORY"));
  assert.ok(result.runs.some((run) => run.reason_code === "ONLY_TEMP_ENTRIES"));
  assert.ok(result.runs.some((run) => run.reason_code === "NEEDS_ATTENTION" || run.reason_code === "UNEXPECTED_ENTRY"));
  assert.equal(JSON.stringify(result).includes("unsafe name"), false);
});

test("invalid scan bounds fall back safely and finite bounds are clamped", () => {
  const root = tempRoot(); createRecoveryJournal({ stateDir: root, runId: "run-bounds" });
  assert.notEqual(scanRecoveryState(root, { maxRuns: Infinity }).status, "BOUNDED_SCAN");
  assert.notEqual(scanRecoveryState(root, { maxRuns: NaN, maxEvents: "unbounded", maxBytes: -1 }).status, "BOUNDED_SCAN");
  assert.equal(scanRecoveryState(root, { maxRuns: 0 }).status, "BOUNDED_SCAN");
});
