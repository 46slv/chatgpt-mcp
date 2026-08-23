import {spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {buildIsolatedGitEnvironment} from "./devexec-mission-reviewed-host-git-env.mjs";

function launchError(code, details = {}) {
  const error = new Error(code);
  Object.assign(error, details);
  return error;
}

function samePath(a, b, platform = process.platform) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function requireFile(filePath, code) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (cause) {
    throw launchError(code, {cause, path: filePath});
  }
  if (!stat.isFile()) throw launchError(code, {path: filePath});
}

function defaultCommandRunner(command, args, {cwd, env}) {
  return spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function runCommand(commandRunner, command, args, options, label) {
  const result = commandRunner(command, args, options);
  if (!result || typeof result !== "object") {
    throw launchError("MISSION_REVIEWED_HOST_COMMAND_RESULT_INVALID", {label});
  }
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  if (result.error) {
    throw launchError("MISSION_REVIEWED_HOST_COMMAND_FAILED", {
      label,
      command,
      args,
      status: typeof result.status === "number" ? result.status : null,
      stdout,
      stderr,
      cause: result.error,
    });
  }
  if (typeof result.status !== "number") {
    throw launchError("MISSION_REVIEWED_HOST_COMMAND_RESULT_INVALID", {
      label,
      status: result.status ?? null,
      stdout,
      stderr,
    });
  }
  if (result.status !== 0) {
    throw launchError("MISSION_REVIEWED_HOST_COMMAND_FAILED", {
      label,
      command,
      args,
      status: result.status,
      stdout,
      stderr,
    });
  }
  return {stdout, stderr};
}

function requireExactMarker(text, marker, label) {
  const found = text.split(/\r?\n/).some((line) => line.trim() === marker);
  if (!found) {
    throw launchError("MISSION_REVIEWED_HOST_PASS_MARKER_MISSING", {label, marker});
  }
}

function validateExpectedHead(expectedHead) {
  const value = String(expectedHead ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw launchError("MISSION_REVIEWED_HOST_EXPECTED_HEAD_INVALID", {expected_head: expectedHead});
  }
  return value;
}

export function runReviewedHostAcceptance({
  reviewedRoot,
  expectedHead,
  evidenceRoot = "",
  powershellExecutable = process.platform === "win32" ? "powershell.exe" : "pwsh",
  baseEnv = process.env,
  commandRunner = defaultCommandRunner,
} = {}) {
  const rootText = String(reviewedRoot ?? "").trim();
  if (!rootText) {
    throw launchError("MISSION_REVIEWED_HOST_ROOT_REQUIRED");
  }
  const powershell = String(powershellExecutable ?? "").trim();
  if (!powershell) {
    throw launchError("MISSION_REVIEWED_HOST_POWERSHELL_REQUIRED");
  }
  const root = path.resolve(rootText);
  const headExpected = validateExpectedHead(expectedHead);
  const toolsDir = path.join(root, "tools");
  const reliabilityScript = path.join(toolsDir, "verify-devexec-mission-constraint-continuation.ps1");
  const hostScript = path.join(toolsDir, "verify-devexec-mission-host-acceptance.ps1");
  requireFile(reliabilityScript, "MISSION_REVIEWED_HOST_RELIABILITY_SCRIPT_MISSING");
  requireFile(hostScript, "MISSION_REVIEWED_HOST_ACCEPTANCE_SCRIPT_MISSING");

  // The raw bootstrap rejects inherited Git authority before it mutates the
  // isolated snapshot. This post-bootstrap launcher independently prevents the
  // unchanged reviewed verifier/host packet from inheriting routing, config,
  // attributes, or replace-object authority from the operator process.
  const childEnv = buildIsolatedGitEnvironment(baseEnv, {globalConfigPath: os.devNull});
  const run = (command, args, label) => runCommand(
    commandRunner,
    command,
    args,
    {cwd: root, env: childEnv},
    label,
  );
  const git = (args, label) => run("git", ["-C", root, ...args], label).stdout.trim();

  const topLevel = git(["rev-parse", "--show-toplevel"], "git-top-level-preflight");
  if (!samePath(topLevel, root)) {
    throw launchError("MISSION_REVIEWED_HOST_GIT_TOPLEVEL_MISMATCH", {
      reviewed_root: root,
      git_toplevel: topLevel,
    });
  }
  const head = git(["rev-parse", "HEAD"], "git-head-preflight").toLowerCase();
  if (head !== headExpected) {
    throw launchError("MISSION_REVIEWED_HOST_HEAD_MISMATCH", {
      expected_head: headExpected,
      observed_head: head,
    });
  }
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"], "git-status-preflight");
  if (status !== "") {
    throw launchError("MISSION_REVIEWED_HOST_WORKTREE_DIRTY", {status});
  }

  const reliability = run(
    powershell,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", reliabilityScript],
    "ordinary-mission-reliability",
  );
  requireExactMarker(reliability.stdout, "MISSION_RELIABILITY_CHECK=PASS", "ordinary-mission-reliability");

  const hostArgs = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    hostScript,
    "-ExpectedHead",
    headExpected,
  ];
  if (String(evidenceRoot ?? "").trim() !== "") {
    hostArgs.push("-EvidenceRoot", path.resolve(String(evidenceRoot)));
  }
  const host = run(powershell, hostArgs, "mission-host-acceptance");
  requireExactMarker(host.stdout, "MISSION_HOST_ACCEPTANCE=PASS", "mission-host-acceptance");

  const postHead = git(["rev-parse", "HEAD"], "git-head-postflight").toLowerCase();
  const postStatus = git(["status", "--porcelain=v1", "--untracked-files=all"], "git-status-postflight");
  if (postHead !== headExpected) {
    throw launchError("MISSION_REVIEWED_HOST_POST_HEAD_MISMATCH", {
      expected_head: headExpected,
      observed_head: postHead,
    });
  }
  if (postStatus !== "") {
    throw launchError("MISSION_REVIEWED_HOST_POST_WORKTREE_DIRTY", {status: postStatus});
  }

  return {
    protocol: "devexec.mission-reviewed-host-launch",
    schema_version: 1,
    reviewed_root: root,
    expected_head: headExpected,
    git_toplevel: topLevel,
    git_environment: "ROUTING_CONFIG_ATTR_REPLACE_ISOLATED",
    ordinary_reliability: "PASS",
    host_acceptance: "PASS",
    postflight_head: postHead,
    postflight_clean: true,
    status: "PASS",
  };
}

function parseCli(argv) {
  let reviewedRoot = "";
  let expectedHead = "";
  let evidenceRoot = "";
  let powershellExecutable = process.platform === "win32" ? "powershell.exe" : "pwsh";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--reviewed-root") reviewedRoot = argv[++i] ?? "";
    else if (arg === "--expected-head") expectedHead = argv[++i] ?? "";
    else if (arg === "--evidence-root") evidenceRoot = argv[++i] ?? "";
    else if (arg === "--powershell") powershellExecutable = argv[++i] ?? "";
    else throw launchError("MISSION_REVIEWED_HOST_UNKNOWN_ARGUMENT", {argument: arg});
  }
  if (!reviewedRoot) throw launchError("MISSION_REVIEWED_HOST_ROOT_REQUIRED");
  if (!powershellExecutable) throw launchError("MISSION_REVIEWED_HOST_POWERSHELL_REQUIRED");
  return {reviewedRoot, expectedHead, evidenceRoot, powershellExecutable};
}

const isMain = process.argv[1]
  ? path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
  : false;

if (isMain) {
  try {
    const result = runReviewedHostAcceptance(parseCli(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write("MISSION_REVIEWED_HOST_LAUNCH=PASS\n");
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      protocol: "devexec.mission-reviewed-host-launch-error",
      schema_version: 1,
      error: error?.message || String(error),
      label: error?.label ?? null,
      expected_head: error?.expected_head ?? null,
      observed_head: error?.observed_head ?? null,
      git_toplevel: error?.git_toplevel ?? null,
      marker: error?.marker ?? null,
      status: error?.status ?? null,
      stderr: error?.stderr ?? null,
    }, null, 2)}\n`);
    process.exitCode = 2;
  }
}
