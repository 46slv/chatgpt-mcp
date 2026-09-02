import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createProviderLeaseManager, providerLeaseKeyDigest, validateProviderLease, PROVIDER_LEASE_SCHEMA } from "./local-provider-lease.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const releaseHelper = path.join(here, "devexec-local-provider-lease-release.ps1");
function root() { return fs.mkdtempSync(path.join(os.tmpdir(), "devexec-provider-lease-")); }
function probe({ live = "LIVE", pid = 1234, time = "134000000000000000", host = "a".repeat(64) } = {}) {
  const owner = { pid, process_start_time: time, host_instance_digest: host };
  return { currentOwner: () => ({ ...owner }), liveness: () => live, owner };
}
function input(extra = {}) { return { provider: "freetoken", deviceIndex: 0, servePort: 1919, modelId: "qwen3.6", runId: "run-lease-1", ...extra }; }
function fileFor(manager, value = input()) { return path.join(manager.stateDir, `${providerLeaseKeyDigest(value)}.lease.json`); }

test("exclusive acquire/release uses an opaque in-memory nonce and exact schema", () => {
  const p = probe(); const manager = createProviderLeaseManager({ stateDir: root(), livenessProbe: p }); const acquired = manager.acquire(input());
  assert.equal(acquired.status, "ACQUIRED"); assert.equal(Object.keys(acquired.lease).join(","), "status,key_digest");
  const stored = JSON.parse(fs.readFileSync(fileFor(manager), "utf8")); assert.equal(stored.schema, PROVIDER_LEASE_SCHEMA); assert.equal(validateProviderLease(stored), stored);
  const released = manager.release(acquired.lease);
  if (process.platform === "win32") { assert.equal(released.status, "RELEASED"); assert.equal(fs.existsSync(fileFor(manager)), false); }
  else { assert.equal(released.status, "NEEDS_ATTENTION"); assert.equal(fs.existsSync(fileFor(manager)), true); }
});

test("same key has one winner while device and port isolate keys", async () => {
  const stateDir = root(); const moduleUrl = pathToFileURL(path.join(here, "local-provider-lease.mjs")).href;
  const code = `import {createProviderLeaseManager} from ${JSON.stringify(moduleUrl)};const p={currentOwner:()=>({pid:process.pid,process_start_time:'134000000000000000',host_instance_digest:'${"b".repeat(64)}'}),liveness:()=> 'LIVE'};const x=createProviderLeaseManager({stateDir:process.argv[1],livenessProbe:p}).acquire({provider:'freetoken',deviceIndex:0,servePort:1919,modelId:'qwen',runId:'run'});process.exit(x.status==='ACQUIRED'?0:7)`;
  const child = () => new Promise((resolve) => { const p = spawn(process.execPath, ["--input-type=module", "-e", code, stateDir], { stdio: "ignore" }); p.on("exit", resolve); });
  const statuses = await Promise.all([child(), child()]); assert.equal(statuses.filter((x) => x === 0).length, 1); assert.equal(statuses.filter((x) => x === 7).length, 1);
  const manager = createProviderLeaseManager({ stateDir, livenessProbe: probe() });
  assert.equal(manager.acquire(input({ deviceIndex: 1 })).status, "ACQUIRED"); assert.equal(manager.acquire(input({ servePort: 1920 })).status, "ACQUIRED");
});

test("active, expired, crashed, malformed and PID-reused files never take over", () => {
  const p = probe(); let tick = new Date("2026-01-01T00:00:00.000Z"); const manager = createProviderLeaseManager({ stateDir: root(), livenessProbe: p, now: () => tick, ttlMs: 1000 });
  assert.equal(manager.acquire(input()).status, "ACQUIRED"); assert.equal(manager.acquire(input()).status, "LEASE_HELD");
  tick = new Date("2026-01-01T00:00:02.000Z"); assert.equal(manager.acquire(input()).status, "STALE_CANDIDATE");
  const crashManager = createProviderLeaseManager({ stateDir: root(), livenessProbe: probe({ live: "MISMATCH" }) }); const f = fileFor(crashManager); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "{bad"); assert.equal(crashManager.acquire(input()).status, "LEASE_NEEDS_ATTENTION");
  const live = probe({ live: "MISMATCH" }); const reuse = createProviderLeaseManager({ stateDir: root(), livenessProbe: live }); const owner = createProviderLeaseManager({ stateDir: reuse.stateDir.replace(/provider-leases-v1$/, ""), livenessProbe: probe() }); assert.equal(owner.acquire(input()).status, "ACQUIRED"); assert.equal(reuse.acquire(input()).status, "LEASE_NEEDS_ATTENTION");
});

test("nonce, owner, file replacement, reparse roots and crash leftovers fail closed", (t) => {
  const p = probe(); const manager = createProviderLeaseManager({ stateDir: root(), livenessProbe: p }); const got = manager.acquire(input()); const f = fileFor(manager);
  const stored = JSON.parse(fs.readFileSync(f, "utf8")); stored.release_nonce = "0".repeat(64); fs.writeFileSync(f, JSON.stringify(stored)); assert.equal(manager.release(got.lease).status, "NEEDS_ATTENTION"); assert.equal(fs.existsSync(f), true);
  const link = path.join(root(), "link"); try { fs.symlinkSync(manager.stateDir, link, process.platform === "win32" ? "junction" : "dir"); } catch { t.skip("links unavailable"); return; }
  assert.throws(() => createProviderLeaseManager({ stateDir: link, livenessProbe: p }), /link|unsafe|canonical/i);
});

test("read-only scan is bounded and does not expose raw owner data", () => {
  const manager = createProviderLeaseManager({ stateDir: root(), livenessProbe: probe() }); manager.acquire(input());
  const before = fs.readFileSync(fileFor(manager), "utf8"); const scan = manager.scan({ maxEntries: 1 }); const after = fs.readFileSync(fileFor(manager), "utf8");
  assert.equal(scan.status, "CLEAN"); assert.equal(before, after); assert.equal(JSON.stringify(scan).includes("134000000000000000"), false); assert.equal(JSON.stringify(scan).includes("1234"), false);
});

test("Windows default process identity can acquire and release without touching a provider", (t) => {
  if (process.platform !== "win32") { t.skip("Windows process identity probe only"); return; }
  const manager = createProviderLeaseManager({ stateDir: root() }); const acquired = manager.acquire(input({ runId: "run-default-probe" }));
  assert.equal(acquired.status, "ACQUIRED"); assert.equal(manager.release(acquired.lease).status, "RELEASED"); assert.equal(fs.existsSync(fileFor(manager)), false);
});

test("Windows handle-bound release never deletes a replacement swapped after open", async (t) => {
  if (process.platform !== "win32") { t.skip("Windows handle race fixture only"); return; }
  const p = probe(); const manager = createProviderLeaseManager({ stateDir: root(), livenessProbe: p }); const acquired = manager.acquire(input({ runId: "run-handle-race" }));
  assert.equal(acquired.status, "ACQUIRED"); const leaseFile = fileFor(manager); const original = `${leaseFile}.original`; const ready = `${leaseFile}.ready`; const proceed = `${leaseFile}.proceed`;
  const identity = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", releaseHelper, "-Mode", "identity", "-LeasePath", leaseFile], { encoding: "utf8", windowsHide: true, timeout: 8_000, maxBuffer: 128 });
  assert.equal(identity.status, 0, identity.stderr); const match = /^IDENTITY ([0-9A-F]{8}) ([0-9A-F]{16})$/.exec(identity.stdout.trim()); assert.ok(match, identity.stdout);
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", releaseHelper, "-Mode", "release", "-LeasePath", leaseFile, "-ExpectedVolumeSerial", match[1], "-ExpectedFileIndex", match[2], "-TestReadyPath", ready, "-TestContinuePath", proceed], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const output = []; child.stdout.on("data", (chunk) => output.push(chunk));
  const deadline = Date.now() + 7_000;
  while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(ready), true, "release helper did not reach its post-open gate");
  fs.renameSync(leaseFile, original); fs.writeFileSync(leaseFile, "replacement\n", { mode: 0o600 }); fs.writeFileSync(proceed, "go\n", { mode: 0o600 });
  const exit = await new Promise((resolve) => child.on("exit", resolve)); const token = Buffer.concat(output).toString("utf8").trim();
  assert.equal(fs.readFileSync(leaseFile, "utf8"), "replacement\n");
  assert.equal(token === "RELEASED" && fs.existsSync(leaseFile), true, "a replacement must never be deleted with RELEASED");
  // If Windows permits the disposition after rename, the exact original is
  // gone; otherwise the helper fails closed and the original remains parked.
  assert.equal((token === "RELEASED" && exit === 0) || (token === "NEEDS_ATTENTION" && fs.existsSync(original)), true, `${token}/${exit}`);
  for (const candidate of [leaseFile, original, ready, proceed]) try { fs.rmSync(candidate, { force: true }); } catch { /* fixture cleanup */ }
});
