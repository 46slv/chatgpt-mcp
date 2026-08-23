import assert from "node:assert/strict";
import {execFileSync, spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {computeRawSnapshotGitTree} from "./devexec-mission-raw-tree.mjs";
import {prepareRawSnapshotExactGitWorkspace} from "./devexec-mission-raw-git-bootstrap.mjs";

function makeOriginal() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mission-raw-exact-git-"));
  const git = args => execFileSync("git", ["-C", root, ...args], {encoding: "utf8"}).trim();
  git(["init", "-q"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  git(["config", "core.autocrlf", "false"]);
  git(["config", "core.filemode", "false"]);
  fs.writeFileSync(path.join(root, "README.md"), "one\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "parent"]);
  fs.mkdirSync(path.join(root, "tools"));
  fs.writeFileSync(path.join(root, "README.md"), "two\n");
  fs.writeFileSync(path.join(root, "tools", "x.mjs"), "export const x = 1;\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "child"]);
  const head = git(["rev-parse", "HEAD"]);
  const tree = git(["rev-parse", "HEAD^{tree}"]);
  const parent = git(["rev-parse", "HEAD^"]);
  const commitObject = execFileSync("git", ["-C", root, "cat-file", "commit", head]);
  fs.rmSync(path.join(root, ".git"), {recursive: true, force: true});
  return {root, head, tree, parent, commitObject};
}

function cleanup(fixture) {
  fs.rmSync(fixture.root, {recursive: true, force: true});
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {encoding: "utf8"}).trim();
}

test("exact commit object restores reviewed HEAD without requiring parent object", () => {
  const fixture = makeOriginal();
  try {
    const result = prepareRawSnapshotExactGitWorkspace(fixture.root, {
      expectedTree: fixture.tree,
      expectedCommit: fixture.head,
      commitObject: fixture.commitObject,
    });
    assert.equal(result.status, "PASS");
    assert.equal(result.head, fixture.head);
    assert.equal(git(fixture.root, ["rev-parse", "HEAD"]), fixture.head);
    assert.equal(git(fixture.root, ["write-tree"]), fixture.tree);
    assert.equal(git(fixture.root, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    assert.equal(computeRawSnapshotGitTree(fixture.root).tree_sha1, fixture.tree);

    const parentProbe = spawnSync(
      "git",
      ["-C", fixture.root, "cat-file", "-e", `${fixture.parent}^{commit}`],
      {encoding: "utf8"},
    );
    assert.notEqual(parentProbe.status, 0);
  } finally {
    cleanup(fixture);
  }
});

test("commit byte mismatch fails before Git metadata is created", () => {
  const fixture = makeOriginal();
  try {
    const bad = Buffer.from(fixture.commitObject);
    bad[bad.length - 1] ^= 1;
    assert.throws(
      () => prepareRawSnapshotExactGitWorkspace(fixture.root, {
        expectedTree: fixture.tree,
        expectedCommit: fixture.head,
        commitObject: bad,
      }),
      error => error?.message === "MISSION_RAW_SNAPSHOT_COMMIT_OBJECT_MISMATCH",
    );
    assert.equal(fs.existsSync(path.join(fixture.root, ".git")), false);
  } finally {
    cleanup(fixture);
  }
});

test("source tree mismatch fails before Git metadata is created", () => {
  const fixture = makeOriginal();
  try {
    assert.throws(
      () => prepareRawSnapshotExactGitWorkspace(fixture.root, {
        expectedTree: "0".repeat(40),
        expectedCommit: fixture.head,
        commitObject: fixture.commitObject,
      }),
      error => error?.message === "MISSION_RAW_SNAPSHOT_TREE_MISMATCH",
    );
    assert.equal(fs.existsSync(path.join(fixture.root, ".git")), false);
  } finally {
    cleanup(fixture);
  }
});

test("pre-existing Git metadata is rejected rather than reusing ambiguous authority", () => {
  const fixture = makeOriginal();
  try {
    execFileSync("git", ["init", "-q", fixture.root]);
    assert.throws(
      () => prepareRawSnapshotExactGitWorkspace(fixture.root, {
        expectedTree: fixture.tree,
        expectedCommit: fixture.head,
        commitObject: fixture.commitObject,
      }),
      error => error?.message === "MISSION_RAW_SNAPSHOT_GIT_METADATA_ALREADY_EXISTS",
    );
  } finally {
    cleanup(fixture);
  }
});
