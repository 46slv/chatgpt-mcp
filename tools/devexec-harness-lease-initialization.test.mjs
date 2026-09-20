import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runOuterCycles } from "./devexec-harness-adapter.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA2 = "89abcdef0123456789abcdef0123456789abcdef";

function fixture(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `devexec-lease-init-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const receiptFile = path.join(root, "outer.json");
  return {
    root,
    receiptFile,
    leaseDirectory: `${path.resolve(receiptFile)}.lease`,
    binding: {
      harness_repository: path.join(root, "harness"),
      harness_commit_sha: SHA,
      target_repository: path.join(root, "target"),
      target_ref: "automation/test-target",
      target_base_sha: SHA2,
      working_directory: path.join(root, "work"),
      evidence_root: path.join(root, "evidence"),
    },
  };
}

function options(f) {
  return {
    receiptFile: f.receiptFile,
    outer_run_id: "outer-init-failure",
    binding: f.binding,
    goal_identity: "goal-1",
    task_identity: "task-1",
    project_adapter: "json",
    maxCycles: 1,
  };
}

function doneCycle(request) {
  return {
    status: "DONE",
    evidence: {
      second_cycle: "NOT_RUN",
      input_state_hash: request.expected_previous_state_hash,
      resulting_state_hash: "a".repeat(64),
      next_action: "STOP",
    },
  };
}

test("owner-file initialization failure cleans the newly-owned lease before any launch", { concurrency: false }, async (t) => {
  const f = fixture(t, "cleaned");
  const originalOpen = fs.openSync;
  let launches = 0;
  let injected = false;
  fs.openSync = function patchedOpen(file, ...args) {
    if (!injected && path.basename(String(file)) === "owner.json") {
      injected = true;
      const error = new Error("injected owner initialization failure");
      error.code = "EIO";
      throw error;
    }
    return originalOpen.call(fs, file, ...args);
  };
  try {
    await assert.rejects(
      () => runOuterCycles({
        ...options(f),
        launchCycle: async (request) => {
          launches += 1;
          return doneCycle(request);
        },
      }),
      (error) => error?.code === "OUTER_RUN_LEASE_INITIALIZATION_FAILED" && error?.lease_residue_cleaned === true,
    );
  } finally {
    fs.openSync = originalOpen;
  }
  assert.equal(launches, 0);
  assert.equal(fs.existsSync(f.leaseDirectory), false);
  assert.equal(fs.existsSync(f.receiptFile), false);

  const retried = await runOuterCycles({
    ...options(f),
    launchCycle: async (request) => {
      launches += 1;
      return doneCycle(request);
    },
  });
  assert.equal(launches, 1);
  assert.equal(retried.receipt.status, "COMPLETE");
  assert.equal(fs.existsSync(f.leaseDirectory), false);
});

test("failed initialization cleanup remains fail-closed as ambiguous residue", { concurrency: false }, async (t) => {
  const f = fixture(t, "cleanup-failed");
  const originalOpen = fs.openSync;
  const originalRmdir = fs.rmdirSync;
  let launches = 0;
  let injected = false;
  fs.openSync = function patchedOpen(file, ...args) {
    if (!injected && path.basename(String(file)) === "owner.json") {
      injected = true;
      const error = new Error("injected owner initialization failure");
      error.code = "EIO";
      throw error;
    }
    return originalOpen.call(fs, file, ...args);
  };
  fs.rmdirSync = function patchedRmdir(dir, ...args) {
    if (path.resolve(String(dir)) === path.resolve(f.leaseDirectory)) {
      const error = new Error("injected cleanup failure");
      error.code = "EACCES";
      throw error;
    }
    return originalRmdir.call(fs, dir, ...args);
  };
  try {
    await assert.rejects(
      () => runOuterCycles({
        ...options(f),
        launchCycle: async (request) => {
          launches += 1;
          return doneCycle(request);
        },
      }),
      (error) => error?.code === "OUTER_RUN_LEASE_INITIALIZATION_FAILED" && error?.lease_residue_cleaned === false,
    );
  } finally {
    fs.openSync = originalOpen;
    fs.rmdirSync = originalRmdir;
  }
  assert.equal(launches, 0);
  assert.equal(fs.existsSync(f.leaseDirectory), true);
  assert.equal(fs.existsSync(f.receiptFile), false);

  await assert.rejects(
    () => runOuterCycles({
      ...options(f),
      launchCycle: async (request) => {
        launches += 1;
        return doneCycle(request);
      },
    }),
    (error) => error?.code === "OUTER_RUN_LEASE_AMBIGUOUS",
  );
  assert.equal(launches, 0);
});
