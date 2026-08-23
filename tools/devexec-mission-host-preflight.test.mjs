import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {inspectMissionHostCheckout} from "./devexec-mission-host-preflight.mjs";

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

function resolvedGitPath(root, name) {
  const observed = git(root, "rev-parse", "--git-path", name);
  return path.isAbsolute(observed) ? observed : path.resolve(root, observed);
}

function withRepo(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-host-preflight-"));
  try {
    git(root, "init", "-q");
    git(root, "config", "user.email", "devexec-test@example.invalid");
    git(root, "config", "user.name", "DevExec Test");
    fs.writeFileSync(path.join(root, "tracked.txt"), "v1\n", "utf8");
    git(root, "add", "tracked.txt");
    git(root, "commit", "-q", "-m", "initial");
    return fn(root, git(root, "rev-parse", "HEAD"));
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
}

test("clean checkout with matching expected HEAD passes", () => withRepo((root, head) => {
  const report = inspectMissionHostCheckout(root, {expectedHead: head});
  assert.equal(report.head, head);
  assert.equal(report.expected_head, head);
  assert.equal(report.git_operation, null);
  assert.equal(report.worktree_clean, true);
  assert.deepEqual(report.dirty_entries, []);
}));

test("tracked modification is rejected before host acceptance", () => withRepo((root, head) => {
  fs.writeFileSync(path.join(root, "tracked.txt"), "changed\n", "utf8");
  assert.throws(
    () => inspectMissionHostCheckout(root, {expectedHead: head}),
    error => {
      assert.equal(error?.message, "MISSION_HOST_PREFLIGHT_DIRTY_WORKTREE");
      assert.equal(error?.observed_head, head);
      assert.equal(error?.dirty_entries?.some(entry => entry.includes("tracked.txt")), true);
      return true;
    },
  );
}));

test("untracked file is rejected before host acceptance", () => withRepo((root, head) => {
  fs.writeFileSync(path.join(root, "untracked.txt"), "new\n", "utf8");
  assert.throws(
    () => inspectMissionHostCheckout(root, {expectedHead: head}),
    error => {
      assert.equal(error?.message, "MISSION_HOST_PREFLIGHT_DIRTY_WORKTREE");
      assert.equal(error?.dirty_entries?.some(entry => entry.includes("untracked.txt")), true);
      return true;
    },
  );
}));

test("clean worktree with MERGE_HEAD is rejected as an in-progress Git operation", () => withRepo((root, head) => {
  const mergeHead = resolvedGitPath(root, "MERGE_HEAD");
  fs.writeFileSync(mergeHead, `${head}\n`, "utf8");
  assert.equal(git(root, "status", "--porcelain=v1", "--untracked-files=all"), "");
  assert.throws(
    () => inspectMissionHostCheckout(root, {expectedHead: head}),
    error => {
      assert.equal(error?.message, "MISSION_HOST_PREFLIGHT_GIT_OPERATION_IN_PROGRESS");
      assert.equal(error?.observed_head, head);
      assert.equal(error?.git_operation, "merge");
      assert.equal(path.resolve(error?.git_operation_path), path.resolve(mergeHead));
      return true;
    },
  );
}));

test("clean worktree with rebase state directory is rejected before host acceptance", () => withRepo((root, head) => {
  const rebaseState = resolvedGitPath(root, "rebase-merge");
  fs.mkdirSync(rebaseState, {recursive: true});
  assert.equal(git(root, "status", "--porcelain=v1", "--untracked-files=all"), "");
  assert.throws(
    () => inspectMissionHostCheckout(root, {expectedHead: head}),
    error => {
      assert.equal(error?.message, "MISSION_HOST_PREFLIGHT_GIT_OPERATION_IN_PROGRESS");
      assert.equal(error?.git_operation, "rebase-merge");
      return true;
    },
  );
}));

test("all declared Git transaction markers fail closed even when porcelain status is clean", () => {
  const cases = [
    ["cherry-pick", "CHERRY_PICK_HEAD", "file"],
    ["revert", "REVERT_HEAD", "file"],
    ["rebase-apply", "rebase-apply", "directory"],
    ["sequencer", "sequencer/todo", "file"],
    ["bisect", "BISECT_START", "file"],
  ];
  for (const [operation, gitPath, kind] of cases) {
    withRepo((root, head) => {
      const statePath = resolvedGitPath(root, gitPath);
      if (kind === "directory") {
        fs.mkdirSync(statePath, {recursive: true});
      } else {
        fs.mkdirSync(path.dirname(statePath), {recursive: true});
        fs.writeFileSync(statePath, `${head}\n`, "utf8");
      }
      assert.equal(
        git(root, "status", "--porcelain=v1", "--untracked-files=all"),
        "",
        `${operation} fixture should remain porcelain-clean`,
      );
      assert.throws(
        () => inspectMissionHostCheckout(root, {expectedHead: head}),
        error => {
          assert.equal(error?.message, "MISSION_HOST_PREFLIGHT_GIT_OPERATION_IN_PROGRESS");
          assert.equal(error?.git_operation, operation);
          return true;
        },
      );
    });
  }
});

test("linked worktree uses its own Git operation state rather than the primary worktree state", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-mission-host-worktree-"));
  const main = path.join(parent, "main");
  const linked = path.join(parent, "linked");
  fs.mkdirSync(main);
  try {
    git(main, "init", "-q");
    git(main, "config", "user.email", "devexec-test@example.invalid");
    git(main, "config", "user.name", "DevExec Test");
    fs.writeFileSync(path.join(main, "tracked.txt"), "v1\n", "utf8");
    git(main, "add", "tracked.txt");
    git(main, "commit", "-q", "-m", "initial");
    git(main, "worktree", "add", "-q", "-b", "linked-probe", linked);

    const head = git(linked, "rev-parse", "HEAD");
    const linkedMergeHead = resolvedGitPath(linked, "MERGE_HEAD");
    const primaryMergeHead = resolvedGitPath(main, "MERGE_HEAD");
    fs.writeFileSync(linkedMergeHead, `${head}\n`, "utf8");

    assert.equal(git(linked, "status", "--porcelain=v1", "--untracked-files=all"), "");
    assert.equal(fs.existsSync(primaryMergeHead), false);
    assert.throws(
      () => inspectMissionHostCheckout(linked, {expectedHead: head}),
      error => {
        assert.equal(error?.message, "MISSION_HOST_PREFLIGHT_GIT_OPERATION_IN_PROGRESS");
        assert.equal(error?.git_operation, "merge");
        assert.equal(path.resolve(error?.git_operation_path), path.resolve(linkedMergeHead));
        return true;
      },
    );
  } finally {
    fs.rmSync(parent, {recursive: true, force: true});
  }
});

test("expected HEAD mismatch is rejected", () => withRepo((root) => {
  const impossible = "0".repeat(40);
  assert.throws(
    () => inspectMissionHostCheckout(root, {expectedHead: impossible}),
    error => {
      assert.equal(error?.message, "MISSION_HOST_PREFLIGHT_HEAD_MISMATCH");
      assert.equal(error?.expected_head, impossible);
      assert.notEqual(error?.observed_head, impossible);
      return true;
    },
  );
}));

test("nested path cannot masquerade as repository root", () => withRepo((root, head) => {
  const nested = path.join(root, "nested");
  fs.mkdirSync(nested);
  assert.throws(
    () => inspectMissionHostCheckout(nested, {expectedHead: head}),
    error => {
      assert.equal(error?.message, "MISSION_HOST_PREFLIGHT_REPO_ROOT_MISMATCH");
      return true;
    },
  );
}));
