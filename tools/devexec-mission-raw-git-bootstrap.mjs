import crypto from "node:crypto";
import {execFileSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {verifyRawSnapshotGitTree} from "./devexec-mission-raw-tree.mjs";

function bootstrapError(code, details = {}) {
  const error = new Error(code);
  Object.assign(error, details);
  return error;
}

function gitObjectSha1(type, bytes) {
  const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return crypto.createHash("sha1")
    .update(Buffer.from(`${type} ${payload.length}\0`, "utf8"))
    .update(payload)
    .digest("hex");
}

function sanitizedGitEnvironment() {
  const env = {...process.env};
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
  ]) {
    delete env[key];
  }
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  env.GIT_CONFIG_COUNT = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = os.devNull;
  env.GIT_ATTR_NOSYSTEM = "1";
  env.GIT_NO_REPLACE_OBJECTS = "1";
  return env;
}

function runGit(root, args, {input = null} = {}) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      input,
      env: sanitizedGitEnvironment(),
      stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
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

function pathEntryExists(entryPath) {
  try {
    fs.lstatSync(entryPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw bootstrapError("MISSION_RAW_SNAPSHOT_GIT_METADATA_INSPECTION_FAILED", {
      cause: error,
      path: entryPath,
    });
  }
}

function validateCommitObject(commitObject, {expectedCommit, expectedTree}) {
  const bytes = Buffer.isBuffer(commitObject) ? commitObject : Buffer.from(commitObject);
  const observedCommit = gitObjectSha1("commit", bytes);
  if (observedCommit !== expectedCommit) {
    throw bootstrapError("MISSION_RAW_SNAPSHOT_COMMIT_OBJECT_MISMATCH", {
      expected_commit: expectedCommit,
      observed_commit: observedCommit,
    });
  }
  const firstNewline = bytes.indexOf(0x0a);
  if (firstNewline <= 0) {
    throw bootstrapError("MISSION_RAW_SNAPSHOT_COMMIT_OBJECT_INVALID");
  }
  const firstHeader = bytes.subarray(0, firstNewline).toString("ascii");
  const match = /^tree ([0-9a-f]{40})$/.exec(firstHeader);
  if (!match) {
    throw bootstrapError("MISSION_RAW_SNAPSHOT_COMMIT_TREE_HEADER_INVALID", {header: firstHeader});
  }
  if (match[1] !== expectedTree) {
    throw bootstrapError("MISSION_RAW_SNAPSHOT_COMMIT_TREE_MISMATCH", {
      expected_tree: expectedTree,
      commit_tree: match[1],
    });
  }
  return {bytes};
}

export function prepareRawSnapshotExactGitWorkspace(root, {
  expectedTree,
  expectedCommit,
  commitObject,
} = {}) {
  const verified = verifyRawSnapshotGitTree(root, {expectedTree, expectedCommit});
  const commit = validateCommitObject(commitObject, {
    expectedCommit: verified.expected_commit,
    expectedTree: verified.expected_tree,
  });
  const gitDir = path.join(verified.root, ".git");
  // existsSync follows symlinks and therefore misses a dangling .git link.
  // Any root .git directory entry is ambiguous pre-existing authority and must
  // be rejected before git init, including files/symlinks with missing targets.
  if (pathEntryExists(gitDir)) {
    throw bootstrapError("MISSION_RAW_SNAPSHOT_GIT_METADATA_ALREADY_EXISTS", {git_dir: gitDir});
  }

  // Do not let an inherited Git routing/config environment redirect bootstrap
  // mutations to some other repository or inject host-specific object/config
  // semantics. Every Git command below runs in an explicitly sanitized env.
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

  const storedCommit = runGit(verified.root, ["hash-object", "-t", "commit", "-w", "--stdin"], {
    input: commit.bytes,
  });
  if (storedCommit !== verified.expected_commit) {
    throw bootstrapError("MISSION_RAW_SNAPSHOT_STORED_COMMIT_MISMATCH", {
      expected_commit: verified.expected_commit,
      stored_commit: storedCommit,
    });
  }
  runGit(verified.root, ["update-ref", "refs/heads/devexec-raw-snapshot", storedCommit]);
  runGit(verified.root, ["symbolic-ref", "HEAD", "refs/heads/devexec-raw-snapshot"]);

  const head = runGit(verified.root, ["rev-parse", "HEAD"]);
  if (head !== verified.expected_commit) {
    throw bootstrapError("MISSION_RAW_SNAPSHOT_HEAD_MISMATCH", {
      expected_commit: verified.expected_commit,
      head,
    });
  }
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
    schema_version: 4,
    source_mode: "raw_snapshot_exact_commit",
    expected_commit: verified.expected_commit,
    expected_tree: verified.expected_tree,
    post_bootstrap_tree: postTree.observed_tree,
    head,
    branch: "devexec-raw-snapshot",
    git_worktree_clean: true,
    git_environment: "SANITIZED",
    nested_git_metadata: "FORBIDDEN",
    status: "PASS",
  };
}

function parseCli(argv) {
  let root = "";
  let expectedTree = "";
  let expectedCommit = "";
  let commitObjectPath = "";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") root = argv[++i] ?? "";
    else if (arg === "--expected-tree") expectedTree = argv[++i] ?? "";
    else if (arg === "--expected-commit") expectedCommit = argv[++i] ?? "";
    else if (arg === "--commit-object") commitObjectPath = argv[++i] ?? "";
    else throw bootstrapError("MISSION_RAW_SNAPSHOT_GIT_BOOTSTRAP_UNKNOWN_ARGUMENT", {argument: arg});
  }
  if (!commitObjectPath) throw bootstrapError("MISSION_RAW_SNAPSHOT_COMMIT_OBJECT_PATH_REQUIRED");
  let commitObject;
  try {
    commitObject = fs.readFileSync(path.resolve(commitObjectPath));
  } catch (cause) {
    throw bootstrapError("MISSION_RAW_SNAPSHOT_COMMIT_OBJECT_READ_FAILED", {cause, path: commitObjectPath});
  }
  return {root, expectedTree, expectedCommit, commitObject};
}

const isMain = process.argv[1]
  ? path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
  : false;

if (isMain) {
  try {
    const options = parseCli(process.argv.slice(2));
    const report = prepareRawSnapshotExactGitWorkspace(options.root, options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write("MISSION_RAW_SNAPSHOT_GIT_BOOTSTRAP=PASS\n");
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      protocol: "devexec.mission-raw-snapshot-git-bootstrap-error",
      schema_version: 4,
      error: error?.message || String(error),
      expected_commit: error?.expected_commit ?? null,
      observed_commit: error?.observed_commit ?? null,
      expected_tree: error?.expected_tree ?? null,
      commit_tree: error?.commit_tree ?? null,
      indexed_tree: error?.indexed_tree ?? null,
      path: error?.path ?? null,
      git_status: error?.git_status ?? null,
      git_stderr: error?.git_stderr ?? null,
    }, null, 2)}\n`);
    process.exitCode = 2;
  }
}
