import {execFileSync} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const IN_PROGRESS_GIT_OPERATIONS = Object.freeze([
  ["merge", "MERGE_HEAD"],
  ["cherry-pick", "CHERRY_PICK_HEAD"],
  ["revert", "REVERT_HEAD"],
  ["rebase-merge", "rebase-merge"],
  ["rebase-apply", "rebase-apply"],
  ["sequencer", "sequencer/todo"],
  ["bisect", "BISECT_START"],
]);

function missionHostPreflightError(code, details = {}) {
  const error = new Error(code);
  Object.assign(error, details);
  return error;
}

function runGit(repoRoot, args) {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (cause) {
    throw missionHostPreflightError("MISSION_HOST_PREFLIGHT_GIT_FAILED", {
      cause,
      git_args: args,
      git_status: cause?.status ?? null,
      git_stdout: String(cause?.stdout ?? "").trim(),
      git_stderr: String(cause?.stderr ?? "").trim(),
    });
  }
}

function canonicalDirectory(directory) {
  const resolved = path.resolve(directory);
  let real;
  try {
    real = typeof fs.realpathSync.native === "function"
      ? fs.realpathSync.native(resolved)
      : fs.realpathSync(resolved);
  } catch (cause) {
    throw missionHostPreflightError("MISSION_HOST_PREFLIGHT_REPO_UNAVAILABLE", {
      cause,
      repo_root: resolved,
    });
  }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

function parsePorcelainZ(output) {
  return String(output ?? "")
    .split("\0")
    .filter(Boolean);
}

function resolveGitPath(repoRoot, gitPath) {
  const observed = runGit(repoRoot, ["rev-parse", "--git-path", gitPath]).trim();
  return path.isAbsolute(observed) ? observed : path.resolve(repoRoot, observed);
}

function findInProgressGitOperation(repoRoot) {
  for (const [operation, gitPath] of IN_PROGRESS_GIT_OPERATIONS) {
    const statePath = resolveGitPath(repoRoot, gitPath);
    if (fs.existsSync(statePath)) {
      return {operation, git_path: gitPath, state_path: statePath};
    }
  }
  return null;
}

export function inspectMissionHostCheckout(repoRoot, {expectedHead = ""} = {}) {
  if (typeof repoRoot !== "string" || !repoRoot.trim()) {
    throw missionHostPreflightError("MISSION_HOST_PREFLIGHT_REPO_REQUIRED");
  }

  const requestedRoot = canonicalDirectory(repoRoot);
  const observedTopLevelRaw = runGit(requestedRoot, ["rev-parse", "--show-toplevel"]).trim();
  const observedTopLevel = canonicalDirectory(observedTopLevelRaw);
  if (observedTopLevel !== requestedRoot) {
    throw missionHostPreflightError("MISSION_HOST_PREFLIGHT_REPO_ROOT_MISMATCH", {
      requested_root: requestedRoot,
      git_toplevel: observedTopLevel,
    });
  }

  const head = runGit(requestedRoot, ["rev-parse", "HEAD"]).trim();
  const branch = runGit(requestedRoot, ["branch", "--show-current"]).trim() || "DETACHED";
  const expected = typeof expectedHead === "string" ? expectedHead.trim() : "";
  if (expected && head !== expected) {
    throw missionHostPreflightError("MISSION_HOST_PREFLIGHT_HEAD_MISMATCH", {
      expected_head: expected,
      observed_head: head,
    });
  }

  const gitOperation = findInProgressGitOperation(requestedRoot);
  if (gitOperation) {
    throw missionHostPreflightError("MISSION_HOST_PREFLIGHT_GIT_OPERATION_IN_PROGRESS", {
      observed_head: head,
      branch,
      git_operation: gitOperation.operation,
      git_operation_path: gitOperation.state_path,
      git_operation_git_path: gitOperation.git_path,
    });
  }

  const dirtyEntries = parsePorcelainZ(
    runGit(requestedRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  );
  if (dirtyEntries.length > 0) {
    throw missionHostPreflightError("MISSION_HOST_PREFLIGHT_DIRTY_WORKTREE", {
      observed_head: head,
      branch,
      dirty_entries: dirtyEntries,
    });
  }

  return {
    protocol: "devexec.mission-host-preflight",
    schema_version: 1,
    repo_root: requestedRoot,
    git_toplevel: observedTopLevel,
    head,
    branch,
    expected_head: expected || null,
    git_operation: null,
    worktree_clean: true,
    dirty_entries: [],
  };
}

function parseCli(argv) {
  let repoRoot = "";
  let expectedHead = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo") {
      repoRoot = argv[++index] ?? "";
    } else if (arg === "--expected-head") {
      expectedHead = argv[++index] ?? "";
    } else {
      throw missionHostPreflightError("MISSION_HOST_PREFLIGHT_UNKNOWN_ARGUMENT", {argument: arg});
    }
  }
  return {repoRoot, expectedHead};
}

const isMain = process.argv[1]
  ? path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
  : false;

if (isMain) {
  try {
    const {repoRoot, expectedHead} = parseCli(process.argv.slice(2));
    const report = inspectMissionHostCheckout(repoRoot, {expectedHead});
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write("MISSION_HOST_PREFLIGHT=PASS\n");
  } catch (error) {
    const report = {
      protocol: "devexec.mission-host-preflight-error",
      schema_version: 1,
      error: error?.message || String(error),
      expected_head: error?.expected_head ?? null,
      observed_head: error?.observed_head ?? null,
      branch: error?.branch ?? null,
      requested_root: error?.requested_root ?? null,
      git_toplevel: error?.git_toplevel ?? null,
      git_operation: error?.git_operation ?? null,
      git_operation_path: error?.git_operation_path ?? null,
      git_operation_git_path: error?.git_operation_git_path ?? null,
      dirty_entries: error?.dirty_entries ?? [],
      git_status: error?.git_status ?? null,
      git_stderr: error?.git_stderr ?? null,
    };
    process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 2;
  }
}
