import {execFileSync} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {verifyRawSnapshotGitTree} from "./devexec-mission-raw-tree.mjs";

function bootstrapError(code, details = {}) {
  const error = new Error(code);
  Object.assign(error, details);
  return error;
}

function runGit(root, args, {env = {}} = {}) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {...process.env, ...env},
    }).trim();
  } catch (cause) {
    throw bootstrapError("MISSION_RAW_SNAPSHOT_GIT_COMMAND_FAILED", {
      cause,
      git_args: args,
      git_status: cause?.status ?? null,
      git_stdout: String(cause?.stdout ?? "").trim(),
      git_stderr: String(cause?.stderr ?? "").trim(),
    });
  }
}

export function prepareRawSnapshotGitWorkspace(root, {expectedTree, expectedCommit} = {}) {
  const verified = verifyRawSnapshotGitTree(root, {expectedTree, expectedCommit});
  const gitDir = path.join(verified.root, ".git");
  if (fs.existsSync(gitDir)) {
    throw bootstrapError("MISSION_RAW_SNAPSHOT_GIT_METADATA_ALREADY_EXISTS", {git_dir: gitDir});
  }

  runGit(verified.root, ["init", "-q"]);
  runGit(verified.root, ["config", "core.autocrlf", "false"]);
  runGit(verified.root, ["config", "core.filemode", "false"]);
  runGit(verified.root, ["add", "-A"]);
  const indexedTree = runGit(verified.root, ["write-tree"]);
  if (indexedTree !== verified.expected_tree) {
    throw bootstrapError("MISSION_RAW_SNAPSHOT_GIT_INDEX_TREE_MISMATCH", {
      expected_tree: verified.expected_tree,
      indexed_tree: indexedTree,
    });
  }

  const syntheticHead = runGit(verified.root, [
    "-c", "user.name=Dev Exec Raw Snapshot",
    "-c", "user.email=devexec-raw-snapshot@invalid",
    "commit-tree", indexedTree,
    "-m", `Synthetic local carrier for reviewed source ${verified.expected_commit ?? "unknown"}`,
  ]);
  runGit(verified.root, ["update-ref", "refs/heads/devexec-raw-snapshot", syntheticHead]);
  runGit(verified.root, ["symbolic-ref", "HEAD", "refs/heads/devexec-raw-snapshot"]);

  const status = runGit(verified.root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status !== "") {
    throw bootstrapError("MISSION_RAW_SNAPSHOT_GIT_WORKTREE_DIRTY_AFTER_BOOTSTRAP", {status});
  }
  const postTree = verifyRawSnapshotGitTree(verified.root, {
    expectedTree: verified.expected_tree,
    expectedCommit: verified.expected_commit,
  });

  return {
    protocol: "devexec.mission-raw-snapshot-git-bootstrap",
    schema_version: 1,
    source_mode: "raw_snapshot",
    expected_commit: verified.expected_commit,
    expected_tree: verified.expected_tree,
    post_bootstrap_tree: postTree.observed_tree,
    synthetic_head: syntheticHead,
    synthetic_branch: "devexec-raw-snapshot",
    git_worktree_clean: true,
    status: "PASS",
  };
}

function parseCli(argv) {
  let root = "";
  let expectedTree = "";
  let expectedCommit = "";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") root = argv[++i] ?? "";
    else if (arg === "--expected-tree") expectedTree = argv[++i] ?? "";
    else if (arg === "--expected-commit") expectedCommit = argv[++i] ?? "";
    else throw bootstrapError("MISSION_RAW_SNAPSHOT_GIT_BOOTSTRAP_UNKNOWN_ARGUMENT", {argument: arg});
  }
  return {root, expectedTree, expectedCommit};
}

const isMain = process.argv[1]
  ? path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
  : false;

if (isMain) {
  try {
    const options = parseCli(process.argv.slice(2));
    const report = prepareRawSnapshotGitWorkspace(options.root, options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write("MISSION_RAW_SNAPSHOT_GIT_BOOTSTRAP=PASS\n");
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      protocol: "devexec.mission-raw-snapshot-git-bootstrap-error",
      schema_version: 1,
      error: error?.message || String(error),
      expected_tree: error?.expected_tree ?? null,
      indexed_tree: error?.indexed_tree ?? null,
      git_status: error?.git_status ?? null,
      git_stderr: error?.git_stderr ?? null,
    }, null, 2)}\n`);
    process.exitCode = 2;
  }
}
