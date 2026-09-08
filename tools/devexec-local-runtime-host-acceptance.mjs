#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SHA = /^[0-9a-f]{40}$/i;
const PASS = new Set(["PASS_OWNED_CLEANUP", "PASS_EXTERNAL_UNCHANGED"]);

function fail(message) {
  const error = new Error(message);
  error.name = "HostAcceptanceProbeError";
  return error;
}

function boundedString(value, name, max = 4096) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw fail(`${name} must be a bounded string`);
  return value.trim();
}

function parseArgs(argv) {
  const out = { repoRoot: process.cwd(), controlUrl: "http://127.0.0.1:1900", serveUrl: "http://127.0.0.1:1919", externalPid: null, timeoutMs: 600000, output: null };
  const map = new Map([
    ["--repo-root", "repoRoot"], ["--expected-consumer-sha", "expectedConsumerSha"], ["--expected-system-sha", "expectedSystemSha"],
    ["--model", "model"], ["--model-path", "modelPath"], ["--cache-dir", "cacheDir"], ["--control-url", "controlUrl"],
    ["--serve-url", "serveUrl"], ["--external-pid", "externalPid"], ["--timeout-ms", "timeoutMs"], ["--output", "output"],
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const key = map.get(argv[i]);
    if (!key) throw fail(`unknown argument: ${argv[i]}`);
    const value = argv[++i];
    if (value === undefined) throw fail(`${argv[i - 1]} requires a value`);
    out[key] = value;
  }
  out.repoRoot = path.resolve(boundedString(out.repoRoot, "repo root"));
  for (const key of ["expectedConsumerSha", "expectedSystemSha"]) {
    if (!SHA.test(String(out[key] || ""))) throw fail(`${key} must be a full commit SHA`);
    out[key] = String(out[key]).toLowerCase();
  }
  out.model = boundedString(out.model, "model", 1024);
  out.modelPath = boundedString(out.modelPath, "model path", 4096);
  out.cacheDir = path.resolve(boundedString(out.cacheDir, "cache dir", 4096));
  out.controlUrl = boundedLoopbackUrl(out.controlUrl, "control URL");
  out.serveUrl = boundedLoopbackUrl(out.serveUrl, "serve URL");
  if (out.externalPid !== null) {
    out.externalPid = Number(out.externalPid);
    if (!Number.isInteger(out.externalPid) || out.externalPid <= 0) throw fail("external pid must be a positive integer");
  }
  out.timeoutMs = Number(out.timeoutMs);
  if (!Number.isInteger(out.timeoutMs) || out.timeoutMs < 1000 || out.timeoutMs > 900000) throw fail("timeout must be 1000..900000 ms");
  out.output = out.output ? path.resolve(boundedString(out.output, "output path", 4096)) : path.join(os.tmpdir(), `dev-lw001-host-acceptance-${Date.now()}.json`);
  if (isWithin(out.repoRoot, out.output)) throw fail("output path must be outside the consumer repository");
  if (isWithin(out.repoRoot, out.cacheDir)) throw fail("cache dir must be outside the consumer repository");
  return Object.freeze(out);
}

function boundedLoopbackUrl(value, name) {
  const text = boundedString(String(value || ""), name, 256).replace(/\/$/, "");
  let parsed;
  try { parsed = new URL(text); } catch { throw fail(`${name} must be a valid URL`); }
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname.toLowerCase())) throw fail(`${name} must be loopback HTTP`);
  return parsed.toString().replace(/\/$/, "");
}

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readBindingSha(repoRoot) {
  const bindingFile = path.join(repoRoot, "tools", "ephemera-runtime-binding.mjs");
  const module = await import(`${pathToFileURL(bindingFile).href}?host-acceptance=${Date.now()}-${process.pid}`);
  if (typeof module.validateEphemeraRuntimeBinding !== "function") throw fail("canonical EPHEMERA runtime binding validator is unavailable");
  const binding = module.validateEphemeraRuntimeBinding(module.EPHEMERA_RUNTIME_BINDING);
  if (!SHA.test(String(binding?.target_commit_sha || ""))) throw fail("canonical EPHEMERA runtime binding SHA is invalid");
  return String(binding.target_commit_sha).toLowerCase();
}

function gitHead(repoRoot) {
  return execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim().toLowerCase();
}

function powershellJson(script) {
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 15000 });
  if (result.error || result.status !== 0) return { status: "AMBIGUOUS", reason: "powershell_probe_failed" };
  try { return JSON.parse(result.stdout.trim() || "null") || { status: "AMBIGUOUS", reason: "empty_powershell_probe" }; }
  catch { return { status: "AMBIGUOUS", reason: "invalid_powershell_probe" }; }
}

function snapshotPort(port) {
  const script = `$ErrorActionPreference='Stop'; try { $pids = @(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction Stop | ForEach-Object { [int]$_.OwningProcess } | Sort-Object -Unique); if ($pids.Count -eq 0) { @{status='FREE'} | ConvertTo-Json -Compress } elseif ($pids.Count -eq 1) { @{status='LISTENING';pid=$pids[0]} | ConvertTo-Json -Compress } else { @{status='AMBIGUOUS';reason='multiple_listeners';count=$pids.Count} | ConvertTo-Json -Compress } } catch { @{status='AMBIGUOUS';reason='port_probe_failed'} | ConvertTo-Json -Compress }`;
  return powershellJson(script);
}

function snapshotProcess(pid) {
  if (!pid) return null;
  const script = `$ErrorActionPreference='Stop'; try { $p = Get-Process -Id ${pid} -ErrorAction Stop; @{status='LIVE';pid=[int]$p.Id;start_time_utc=$p.StartTime.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress } catch { @{status='MISSING';pid=${pid}} | ConvertTo-Json -Compress }`;
  return powershellJson(script);
}

async function snapshotControl(controlUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${controlUrl}/health`, { signal: controller.signal });
    if (!response.ok) return { status: "AMBIGUOUS", reason: `control_http_${response.status}` };
    const body = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.prototype.hasOwnProperty.call(body, "error")) return { status: "AMBIGUOUS", reason: "control_health_malformed" };
    const state = String(body.state ?? body.engineState ?? body.status ?? "").trim().toLowerCase();
    if (body.engineRunning === true || body.ready === true || ["running", "ready", "healthy"].includes(state)) return { status: "RUNNING" };
    if (body.engineRunning === false || body.ready === false || ["stopped", "offline", "unavailable", "not_ready", "not-ready"].includes(state)) return { status: "STOPPED" };
    return { status: "AMBIGUOUS", reason: "control_health_state_unknown" };
  } catch {
    return { status: "AMBIGUOUS", reason: "control_health_unavailable" };
  } finally { clearTimeout(timer); }
}

function externalPrecondition(before, externalPid) {
  return before.process?.status === "LIVE" && before.process.pid === externalPid && typeof before.process.start_time_utc === "string" && before.port?.status === "LISTENING" && before.port.pid === externalPid;
}

export function classifyHostAcceptance({ observedConsumerSha, expectedConsumerSha, bindingSha, expectedSystemSha, externalPid = null, before, after, cliExitCode, cliStatus }) {
  if (observedConsumerSha !== expectedConsumerSha) return { status: "BLOCKED", code: "CONSUMER_SHA_MISMATCH" };
  if (bindingSha !== expectedSystemSha) return { status: "BLOCKED", code: "BINDING_SHA_MISMATCH" };
  if (!before || !after || !before.port || !after.port) return { status: "BLOCKED", code: "SNAPSHOT_MISSING" };

  if (externalPid !== null) {
    if (!externalPrecondition(before, externalPid)) return { status: "BLOCKED", code: "EXTERNAL_PRECONDITION_UNPROVEN" };
    const sameProcess = after.process?.status === "LIVE" && after.process.pid === externalPid && after.process.start_time_utc === before.process.start_time_utc;
    const samePort = after.port?.status === "LISTENING" && after.port.pid === externalPid;
    if (!sameProcess || !samePort) return { status: "FAIL", code: "EXTERNAL_RUNTIME_CHANGED" };
    if (cliExitCode !== 0 || cliStatus !== "DONE") return { status: "FAIL", code: "CLI_NOT_DONE_EXTERNAL_PRESERVED" };
    return { status: "PASS", code: "PASS_EXTERNAL_UNCHANGED" };
  }

  if (before.port.status === "AMBIGUOUS" || before.control?.status === "AMBIGUOUS") return { status: "BLOCKED", code: "OWNED_PRECONDITION_AMBIGUOUS" };
  if (before.port.status !== "FREE") return { status: "BLOCKED", code: "UNDECLARED_EXTERNAL_RUNTIME_PRESENT" };
  if (before.control?.status !== "STOPPED") return { status: "BLOCKED", code: "OWNED_PRECONDITION_NOT_STOPPED" };
  if (after.port.status === "AMBIGUOUS") return { status: "BLOCKED", code: "POST_PORT_AMBIGUOUS" };
  if (after.port.status !== "FREE") return { status: "FAIL", code: "OWNED_PORT_SURVIVED" };
  if (after.control?.status === "AMBIGUOUS") return { status: "BLOCKED", code: "POST_CONTROL_AMBIGUOUS" };
  if (after.control?.status === "RUNNING") return { status: "FAIL", code: "OWNED_ENGINE_SURVIVED" };
  if (after.control?.status !== "STOPPED") return { status: "BLOCKED", code: "POST_CONTROL_UNCLASSIFIED" };
  if (cliExitCode !== 0 || cliStatus !== "DONE") return { status: "FAIL", code: "CLI_NOT_DONE_AFTER_CLEANUP" };
  return { status: "PASS", code: "PASS_OWNED_CLEANUP" };
}

function writeEvidence(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.renameSync(temp, target);
}

async function createFixture(repoRoot, root) {
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, "README.md"), "host acceptance fixture\n", "utf8");
  execFileSync("git", ["-C", worktree, "init", "-q"]);
  execFileSync("git", ["-C", worktree, "config", "user.email", "host-acceptance@example.invalid"]);
  execFileSync("git", ["-C", worktree, "config", "user.name", "DevExec Host Acceptance"]);
  execFileSync("git", ["-C", worktree, "add", "README.md"]);
  execFileSync("git", ["-C", worktree, "commit", "-q", "-m", "fixture"]);
  const base = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const runtime = await import(pathToFileURL(path.join(repoRoot, "tools", "local-worker-runtime.mjs")).href);
  const task = runtime.createTaskContract({
    task_id: "dev-lw001-host-acceptance",
    repo: worktree,
    worktree,
    base_commit: base,
    goal: "Create result.txt containing exactly DEV-LW-001-HOST-OK and do not modify any other file.",
    allowed_paths: ["result.txt"],
    constraints: ["no commit", "modify only result.txt"],
    test_command: [process.execPath, "-e", "const fs=require('fs'); const p='result.txt'; process.exit(fs.existsSync(p)&&fs.readFileSync(p,'utf8').trim()==='DEV-LW-001-HOST-OK'?0:1)"],
    timeout: 180000,
    max_tool_calls: 8,
    output_limit: 8000,
  });
  const taskFile = path.join(root, "task.json");
  fs.writeFileSync(taskFile, `${JSON.stringify(task, null, 2)}\n`, "utf8");
  return { worktree, taskFile };
}

function parseCliStatus(stdout) {
  try { return JSON.parse(String(stdout || "")).status || "UNKNOWN"; } catch { return "MALFORMED"; }
}

export async function runProbe(options) {
  const observedConsumerSha = gitHead(options.repoRoot);
  const bindingSha = await readBindingSha(options.repoRoot);
  const baseEvidence = {
    schema: "devexec.local-runtime-host-acceptance/v1",
    observed_consumer_sha: observedConsumerSha,
    expected_consumer_sha: options.expectedConsumerSha,
    observed_system_binding_sha: bindingSha,
    expected_system_sha: options.expectedSystemSha,
    mode: options.externalPid ? "EXTERNAL_INVARIANCE" : "OWNED_CLEANUP",
    external_pid: options.externalPid,
    model: path.basename(options.model.replace(/\\/g, "/")),
  };

  // Exact identity gates happen before any provider or CLI action.
  const identityDecision = classifyHostAcceptance({
    observedConsumerSha, expectedConsumerSha: options.expectedConsumerSha, bindingSha, expectedSystemSha: options.expectedSystemSha,
    externalPid: null, before: { port: { status: "FREE" }, control: { status: "STOPPED" } }, after: { port: { status: "FREE" }, control: { status: "STOPPED" } }, cliExitCode: 0, cliStatus: "DONE",
  });
  if (["CONSUMER_SHA_MISMATCH", "BINDING_SHA_MISMATCH"].includes(identityDecision.code)) return { ...baseEvidence, ...identityDecision, cli_attempted: false };

  const port = Number(new URL(options.serveUrl).port || 80);
  const before = { port: snapshotPort(port), process: snapshotProcess(options.externalPid), control: await snapshotControl(options.controlUrl) };
  if (options.externalPid !== null && !externalPrecondition(before, options.externalPid)) {
    return { ...baseEvidence, status: "BLOCKED", code: "EXTERNAL_PRECONDITION_UNPROVEN", cli_attempted: false, before };
  }
  if (options.externalPid === null) {
    let code = null;
    if (before.port.status === "AMBIGUOUS" || before.control.status === "AMBIGUOUS") code = "OWNED_PRECONDITION_AMBIGUOUS";
    else if (before.port.status !== "FREE") code = "UNDECLARED_EXTERNAL_RUNTIME_PRESENT";
    else if (before.control.status !== "STOPPED") code = "OWNED_PRECONDITION_NOT_STOPPED";
    if (code) return { ...baseEvidence, status: "BLOCKED", code, cli_attempted: false, before };
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dev-lw001-host-probe-"));
  try {
    const fixture = await createFixture(options.repoRoot, root);
    const state = path.join(root, "state");
    const cliEvidence = path.join(root, "runtime-evidence.json");
    const cliOutput = path.join(root, "runtime-output.json");
    const args = [
      path.join(options.repoRoot, "tools", "devexec-runtime-cli.mjs"), "run", "--task", fixture.taskFile,
      "--runtime", "local", "--provider", "freetoken", "--enabled", "--model", options.model, "--model-path", options.modelPath,
      "--control-url", options.controlUrl, "--serve-url", options.serveUrl,
      "--ledger-dir", path.join(state, "ledger"), "--recovery-dir", path.join(state, "recovery"), "--lease-dir", path.join(state, "lease"),
      "--ephemera-cache-dir", options.cacheDir, "--evidence", cliEvidence, "--output", cliOutput,
    ];
    const cli = spawnSync(process.execPath, args, { cwd: options.repoRoot, encoding: "utf8", windowsHide: true, timeout: options.timeoutMs, maxBuffer: 1024 * 1024 });
    const cliExitCode = Number.isInteger(cli.status) ? cli.status : 1;
    const cliStatus = parseCliStatus(cli.stdout);
    const after = { port: snapshotPort(port), process: snapshotProcess(options.externalPid), control: await snapshotControl(options.controlUrl) };
    const decision = classifyHostAcceptance({ observedConsumerSha, expectedConsumerSha: options.expectedConsumerSha, bindingSha, expectedSystemSha: options.expectedSystemSha, externalPid: options.externalPid, before, after, cliExitCode, cliStatus });
    return { ...baseEvidence, ...decision, cli_attempted: true, cli_exit_code: cliExitCode, cli_status: cliStatus, timed_out: Boolean(cli.error?.code === "ETIMEDOUT"), before, after };
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* evidence already external */ }
  }
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(argv); }
  catch (error) { process.stderr.write(`${error.message}\n`); return 2; }
  if (process.platform !== "win32") {
    const evidence = { schema: "devexec.local-runtime-host-acceptance/v1", status: "BLOCKED", code: "WINDOWS_REQUIRED", cli_attempted: false };
    writeEvidence(options.output, evidence); process.stdout.write(`${JSON.stringify(evidence)}\n`); return 2;
  }
  let evidence;
  try { evidence = await runProbe(options); }
  catch (error) { evidence = { schema: "devexec.local-runtime-host-acceptance/v1", status: "BLOCKED", code: "PROBE_ERROR", reason: String(error?.message || error).slice(0, 1000), cli_attempted: false }; }
  writeEvidence(options.output, evidence);
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
  return PASS.has(evidence.code) ? 0 : evidence.status === "FAIL" ? 1 : 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().then((code) => { process.exitCode = code; }, () => { process.exitCode = 2; });
}
