import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
