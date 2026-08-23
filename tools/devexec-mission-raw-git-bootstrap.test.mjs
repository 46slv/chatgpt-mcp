import assert from "node:assert/strict";
import {execFileSync, spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

import {computeRawSnapshotGitTree} from "./devexec-mission-raw-tree.mjs";
import {prepareRawSnapshotExactGitWorkspace} from "./devexec-mission-raw-git-bootstrap.mjs";

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const reviewedCommitObject = path.join(toolsDir, "devexec-reviewed-commit-3778734.commit");
const hostPreflight = path.join(toolsDir, "devexec-mission-host-preflight.mjs");

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

test("reviewed continuation commit artifact hashes to its exact GitHub commit and tree", () => {
  const hash = execFileSync(
    "git",
    ["hash-object", "-t", "commit", reviewedCommitObject],
    {encoding: "utf8"},
  ).trim();
  assert.equal(hash, "3778734b6fc1a9e22b59adaa49803ac1daca49e2");
  const bytes = fs.readFileSync(reviewedCommitObject, "utf8");
  assert.match(bytes, /^tree ddc1f9ed6b09421b441f14a4afdc0137d68ba148\n/);
  assert.equal(bytes.endsWith("\n"), false);
});

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

test("exact raw bootstrap satisfies the existing clean-checkout host preflight", () => {
  const fixture = makeOriginal();
  try {
    prepareRawSnapshotExactGitWorkspace(fixture.root, {
      expectedTree: fixture.tree,
      expectedCommit: fixture.head,
      commitObject: fixture.commitObject,
    });
    const preflight = spawnSync(
      process.execPath,
      [hostPreflight, "--repo", fixture.root, "--expected-head", fixture.head],
      {encoding: "utf8"},
    );
    assert.equal(preflight.status, 0, `${preflight.stdout}\n${preflight.stderr}`);
    assert.match(preflight.stdout, /^MISSION_HOST_PREFLIGHT=PASS$/m);
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

test("nested Git metadata is rejected before root repository metadata is created", () => {
  const fixture = makeOriginal();
  try {
    const nestedGit = path.join(fixture.root, "nested", ".git");
    fs.mkdirSync(nestedGit, {recursive: true});
    fs.writeFileSync(path.join(nestedGit, "config"), "hidden\n");
    assert.throws(
      () => prepareRawSnapshotExactGitWorkspace(fixture.root, {
        expectedTree: fixture.tree,
        expectedCommit: fixture.head,
        commitObject: fixture.commitObject,
      }),
      error => error?.message === "MISSION_RAW_SNAPSHOT_NESTED_GIT_METADATA_FORBIDDEN",
    );
    assert.equal(fs.existsSync(path.join(fixture.root, ".git")), false);
  } finally {
    cleanup(fixture);
  }
});

test("dangling root .git symlink is rejected as pre-existing metadata", {skip: process.platform === "win32"}, () => {
  const fixture = makeOriginal();
  try {
    const gitPath = path.join(fixture.root, ".git");
    fs.symlinkSync(path.join(fixture.root, "missing-git-target"), gitPath, "dir");
    assert.equal(fs.existsSync(gitPath), false, "precondition: dangling link is invisible to existsSync");
    assert.throws(
      () => prepareRawSnapshotExactGitWorkspace(fixture.root, {
        expectedTree: fixture.tree,
        expectedCommit: fixture.head,
        commitObject: fixture.commitObject,
      }),
      error => error?.message === "MISSION_RAW_SNAPSHOT_GIT_METADATA_ALREADY_EXISTS",
    );
    assert.equal(fs.lstatSync(gitPath).isSymbolicLink(), true);
  } finally {
    cleanup(fixture);
  }
});
