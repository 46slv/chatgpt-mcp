import assert from "node:assert/strict";
import {execFileSync, spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

import {computeRawSnapshotGitTree, verifyRawSnapshotGitTree} from "./devexec-mission-raw-tree.mjs";

const self = fileURLToPath(import.meta.url);
const tool = path.join(path.dirname(self), "devexec-mission-raw-tree.mjs");

function withTemp(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mission-raw-tree-"));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
}

function gitTree(root) {
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "core.autocrlf", "false"]);
  execFileSync("git", ["-C", root, "config", "core.filemode", "false"]);
  execFileSync("git", ["-C", root, "add", "-A"]);
  return execFileSync("git", ["-C", root, "write-tree"], {encoding: "utf8"}).trim();
}

test("filesystem Git tree hash matches git write-tree for exact bytes and names", () => withTemp(root => {
  fs.mkdirSync(path.join(root, "dir"));
  fs.writeFileSync(path.join(root, "a.txt"), "alpha\n");
  fs.writeFileSync(path.join(root, "foo"), "prefix-file\n");
  fs.writeFileSync(path.join(root, "foo.bar"), "neighbor\n");
  fs.writeFileSync(path.join(root, "dir", "日本語.txt"), Buffer.from([0x00, 0x01, 0x7f, 0x80, 0xff]));
  const expected = gitTree(root);
  const observed = computeRawSnapshotGitTree(root);
  assert.equal(observed.tree_sha1, expected);
  assert.equal(observed.file_count, 4);
}));

test(".git metadata and empty directories do not alter the source tree identity", () => withTemp(root => {
  fs.writeFileSync(path.join(root, "tracked.txt"), "tracked\n");
  const expected = gitTree(root);
  fs.mkdirSync(path.join(root, "empty"));
  const observed = verifyRawSnapshotGitTree(root, {expectedTree: expected});
  assert.equal(observed.tree_identity, "PASS");
  assert.equal(observed.file_count, 1);
}));

test("one extra or changed byte fails closed", () => withTemp(root => {
  fs.writeFileSync(path.join(root, "tracked.txt"), "before\n");
  const expected = gitTree(root);
  fs.writeFileSync(path.join(root, "tracked.txt"), "after\n");
  assert.throws(
    () => verifyRawSnapshotGitTree(root, {expectedTree: expected}),
    error => error?.message === "MISSION_RAW_SNAPSHOT_TREE_MISMATCH" && error?.expected_tree === expected,
  );
}));

test("CLI emits an exact PASS marker only on a matching tree", () => withTemp(root => {
  fs.writeFileSync(path.join(root, "tracked.txt"), "cli\n");
  const expected = gitTree(root);
  const pass = spawnSync(
    process.execPath,
    [tool, "--root", root, "--expected-tree", expected, "--expected-commit", "1".repeat(40)],
    {encoding: "utf8"},
  );
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(pass.stdout, /\nMISSION_RAW_SNAPSHOT_TREE=PASS\n$/);

  const fail = spawnSync(
    process.execPath,
    [tool, "--root", root, "--expected-tree", "0".repeat(40)],
    {encoding: "utf8"},
  );
  assert.equal(fail.status, 2);
  assert.doesNotMatch(fail.stdout, /MISSION_RAW_SNAPSHOT_TREE=PASS/);
  assert.match(fail.stderr, /MISSION_RAW_SNAPSHOT_TREE_MISMATCH/);
}));
