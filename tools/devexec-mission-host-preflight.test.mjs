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
