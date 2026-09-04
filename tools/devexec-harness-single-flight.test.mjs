import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runOuterCycles } from "./devexec-harness-adapter.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA2 = "89abcdef0123456789abcdef0123456789abcdef";
const ADAPTER = fileURLToPath(new URL("./devexec-harness-adapter.mjs", import.meta.url));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await sleep(10);
  }
  throw new Error(`timeout waiting for ${file}`);
}

function fixture(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `devexec-outer-lease-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const evidenceRoot = path.join(root, "evidence");
  const workingDirectory = path.join(root, "work");
  fs.mkdirSync(evidenceRoot, { recursive: true });
  fs.mkdirSync(workingDirectory, { recursive: true });
  const receiptFile = path.join(root, "outer.json");
  return {
    root,
    receiptFile,
    leaseDirectory: `${path.resolve(receiptFile)}.lease`,
    ownerFile: `${path.resolve(receiptFile)}.lease${path.sep}owner.json`,
    enteredFile: path.join(root, "entered.txt"),
    releaseFile: path.join(root, "release.txt"),
    sideEffectFile: path.join(root, "side-effect.txt"),
    binding: {
      harness_repository: path.join(root, "harness"),
      harness_commit_sha: SHA,
      target_repository: path.join(root, "target"),
      target_ref: "automation/test-target",
      target_base_sha: SHA2,
      working_directory: workingDirectory,
      evidence_root: evidenceRoot,
    },
  };
}

function options(f) {
  return {
    receiptFile: f.receiptFile,
    outer_run_id: "outer-single-flight",
    binding: f.binding,
    goal_identity: "goal-1",
    task_identity: "task-1",
    project_adapter: "json",
    maxCycles: 1,
  };
}

function sideEffectCount(f) {
  if (!fs.existsSync(f.sideEffectFile)) return 0;
  return fs.readFileSync(f.sideEffectFile, "utf8").split(/\r?\n/).filter(Boolean).length;
}

function writeWorker(f) {
  const worker = path.join(f.root, "worker.mjs");
  fs.writeFileSync(worker, `
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const [adapterPath, configPath, mode] = process.argv.slice(2);
const { runOuterCycles } = await import(pathToFileURL(adapterPath).href);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
let launches = 0;
try {
  const out = await runOuterCycles({
    ...config.options,
    launchCycle: async (request) => {
      launches += 1;
      fs.appendFileSync(config.sideEffectFile, String(process.pid) + "\\n", "utf8");
      if (mode === "hold") {
        fs.writeFileSync(config.enteredFile, String(process.pid), "utf8");
        while (!fs.existsSync(config.releaseFile)) await sleep(10);
      }
      return {
        status: "DONE",
        evidence: {
          second_cycle: "NOT_RUN",
          input_state_hash: request.expected_previous_state_hash,
          resulting_state_hash: "a".repeat(64),
          next_action: "STOP"
        }
      };
    }
  });
  process.stdout.write(JSON.stringify({ ok: true, launches, decision: out.decision, status: out.receipt.status }));
} catch (error) {
  process.stderr.write(JSON.stringify({ ok: false, launches, code: error.code || null, message: error.message }));
  process.exitCode = 2;
}
`, "utf8");
  const config = path.join(f.root, "worker-config.json");
  fs.writeFileSync(config, JSON.stringify({
    options: options(f),
    sideEffectFile: f.sideEffectFile,
    enteredFile: f.enteredFile,
    releaseFile: f.releaseFile,
  }), "utf8");
  return { worker, config };
}

function spawnWorker(worker, config, mode) {
  const child = spawn(process.execPath, [worker, ADAPTER, config, mode], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done };
}

test("two overlapping OS processes admit at most one Harness child launch", async (t) => {
  const f = fixture(t, "contended");
  const { worker, config } = writeWorker(f);
  const owner = spawnWorker(worker, config, "hold");
  await waitForFile(f.enteredFile);
  assert.equal(fs.existsSync(f.leaseDirectory), true);
  assert.equal(fs.existsSync(f.ownerFile), true);
  assert.equal(sideEffectCount(f), 1);

  const contender = spawnWorker(worker, config, "immediate");
  const contenderResult = await contender.done;
  assert.equal(contenderResult.code, 2);
  assert.match(contenderResult.stderr, /OUTER_RUN_LEASE_HELD/);
  assert.equal(sideEffectCount(f), 1);

  fs.writeFileSync(f.releaseFile, "release", "utf8");
  const ownerResult = await owner.done;
  assert.equal(ownerResult.code, 0, ownerResult.stderr);
  assert.equal(sideEffectCount(f), 1);
  assert.equal(fs.existsSync(f.leaseDirectory), false);
  const receipt = JSON.parse(fs.readFileSync(f.receiptFile, "utf8"));
  assert.equal(receipt.cycles.length, 1);
  assert.equal(receipt.pending_cycle, null);
  assert.equal(receipt.status, "COMPLETE");
});

test("crashed owner leaves a durable lease and restart fails closed without replay", async (t) => {
  const f = fixture(t, "stale");
  const { worker, config } = writeWorker(f);
  const owner = spawnWorker(worker, config, "hold");
  await waitForFile(f.enteredFile);
  assert.equal(sideEffectCount(f), 1);
  const pending = JSON.parse(fs.readFileSync(f.receiptFile, "utf8"));
  assert.equal(pending.cycles.length, 0);
  assert.equal(pending.pending_cycle.child_run_id, "outer-single-flight-cycle-0");

  owner.child.kill("SIGKILL");
  await owner.done;
  assert.equal(fs.existsSync(f.leaseDirectory), true);
  assert.equal(fs.existsSync(f.ownerFile), true);

  const contender = spawnWorker(worker, config, "immediate");
  const contenderResult = await contender.done;
  assert.equal(contenderResult.code, 2);
  assert.match(contenderResult.stderr, /OUTER_RUN_LEASE_HELD/);
  assert.equal(sideEffectCount(f), 1);

  fs.rmSync(f.leaseDirectory, { recursive: true, force: true });
  let relaunches = 0;
  const reconciled = await runOuterCycles({
    ...options(f),
    launchCycle: async () => {
      relaunches += 1;
      throw new Error("must not relaunch unresolved pending child");
    },
  });
  assert.equal(relaunches, 0);
  assert.equal(reconciled.decision.reason, "AMBIGUOUS_IN_FLIGHT_CHILD");
  assert.equal(reconciled.receipt.status, "NEEDS_HUMAN");
  assert.equal(sideEffectCount(f), 1);
});

test("malformed pre-existing lease is ambiguous and blocks receipt mutation or launch", async (t) => {
  const f = fixture(t, "ambiguous");
  fs.mkdirSync(f.leaseDirectory, { recursive: true });
  let launches = 0;
  await assert.rejects(
    () => runOuterCycles({
      ...options(f),
      launchCycle: async () => {
        launches += 1;
        return {};
      },
    }),
    (error) => error?.code === "OUTER_RUN_LEASE_AMBIGUOUS" && error?.message === "OUTER_RUN_LEASE_AMBIGUOUS",
  );
  assert.equal(launches, 0);
  assert.equal(fs.existsSync(f.receiptFile), false);
});
