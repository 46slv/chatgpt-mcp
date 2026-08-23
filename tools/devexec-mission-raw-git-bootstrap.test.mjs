import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {computeRawSnapshotGitTree} from "./devexec-mission-raw-tree.mjs";
import {prepareRawSnapshotGitWorkspace} from "./devexec-mission-raw-git-bootstrap.mjs";

function withTemp(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mission-raw-bootstrap-"));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {encoding: "utf8"}).trim();
}

test("bootstrap creates only ignored Git metadata and a clean synthetic carrier", () => withTemp(root => {
  fs.mkdirSync(path.join(root, "tools"));
  fs.writeFileSync(path.join(root, "README.md"), "raw source\n");
  fs.writeFileSync(path.join(root, "tools", "x.mjs"), "export const x = 1;\n");
  const expected = computeRawSnapshotGitTree(root).tree_sha1;
  const result = prepareRawSnapshotGitWorkspace(root, {
    expectedTree: expected,
    expectedCommit: "a".repeat(40),
  });
  assert.equal(result.status, "PASS");
  assert.equal(result.expected_tree, expected);
  assert.equal(git(root, ["write-tree"]), expected);
  assert.equal(git(root, ["rev-parse", "HEAD"]), result.synthetic_head);
  assert.equal(git(root, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  assert.equal(computeRawSnapshotGitTree(root).tree_sha1, expected);
}));

test("tree mismatch fails before Git metadata is created", () => withTemp(root => {
  fs.writeFileSync(path.join(root, "README.md"), "raw source\n");
  assert.throws(
    () => prepareRawSnapshotGitWorkspace(root, {
      expectedTree: "0".repeat(40),
      expectedCommit: "a".repeat(40),
    }),
    error => error?.message === "MISSION_RAW_SNAPSHOT_TREE_MISMATCH",
  );
  assert.equal(fs.existsSync(path.join(root, ".git")), false);
}));

test("pre-existing Git metadata is rejected rather than reusing ambiguous authority", () => withTemp(root => {
  fs.writeFileSync(path.join(root, "README.md"), "raw source\n");
  const expected = computeRawSnapshotGitTree(root).tree_sha1;
  execFileSync("git", ["init", "-q", root]);
  assert.throws(
    () => prepareRawSnapshotGitWorkspace(root, {
      expectedTree: expected,
      expectedCommit: "a".repeat(40),
    }),
    error => error?.message === "MISSION_RAW_SNAPSHOT_GIT_METADATA_ALREADY_EXISTS",
  );
}));
