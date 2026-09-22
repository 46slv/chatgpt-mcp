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
    ownerFile: path.join(`${path.resolve(receiptFile)}.lease`, "owner.json"),
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

function replacementOwner(f) {
  return {
    schema: "devexec.harness-outer-lease.v1",
    owner_token: "foreign-replacement-owner",
    process_id: process.pid + 1000,
    receipt_file: path.resolve(f.receiptFile),
    outer_run_id: "outer-init-failure",
    goal_identity: "goal-1",
    task_identity: "task-1",
    project_adapter: "json",
    harness_commit_sha: SHA,
    target_base_sha: SHA2,
    target_ref: "automation/test-target",
    acquired_at: new Date().toISOString(),
  };
}

async function assertAmbiguousOnRetry(f, launchCounter) {
  await assert.rejects(
    () => runOuterCycles({
      ...options(f),
      launchCycle: async () => {
        launchCounter.count += 1;
        return {};
      },
    }),
    (error) => error?.code === "OUTER_RUN_LEASE_AMBIGUOUS",
  );
  assert.equal(launchCounter.count, 0);
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
      launchCycle: async () => {
        launches += 1;
        return {};
      },
    }),
    (error) => error?.code === "OUTER_RUN_LEASE_AMBIGUOUS",
  );
  assert.equal(launches, 0);
});

test("foreign replacement owner published during failed initialization is preserved and blocks retry", { concurrency: false }, async (t) => {
  const f = fixture(t, "foreign-owner");
  const originalOpen = fs.openSync;
  const foreign = replacementOwner(f);
  let launches = 0;
  let injected = false;
  fs.openSync = function patchedOpen(file, ...args) {
    if (!injected && path.resolve(String(file)) === path.resolve(f.ownerFile)) {
      injected = true;
      const fd = originalOpen.call(fs, file, "wx", 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify(foreign, null, 2)}\n`, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      const error = new Error("injected initialization failure after foreign publication");
      error.code = "EIO";
      throw error;
    }
    return originalOpen.call(fs, file, ...args);
  };
  try {
    await assert.rejects(
      () => runOuterCycles({
        ...options(f),
        launchCycle: async () => {
          launches += 1;
          return {};
        },
      }),
      (error) => error?.code === "OUTER_RUN_LEASE_INITIALIZATION_FAILED" && error?.lease_residue_cleaned === false,
    );
  } finally {
    fs.openSync = originalOpen;
  }

  assert.equal(launches, 0);
  assert.equal(fs.existsSync(f.leaseDirectory), true);
  assert.equal(fs.existsSync(f.ownerFile), false);
  const entries = fs.readdirSync(f.leaseDirectory);
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^owner\.cleanup-.+\.json$/);
  const preserved = JSON.parse(fs.readFileSync(path.join(f.leaseDirectory, entries[0]), "utf8"));
  assert.deepEqual(preserved, foreign);

  await assertAmbiguousOnRetry(f, { get count() { return launches; }, set count(value) { launches = value; } });
});

test("unreadable owner residue published during failed initialization is preserved and blocks retry", { concurrency: false }, async (t) => {
  const f = fixture(t, "unreadable-owner");
  const originalOpen = fs.openSync;
  let launches = 0;
  let injected = false;
  fs.openSync = function patchedOpen(file, ...args) {
    if (!injected && path.resolve(String(file)) === path.resolve(f.ownerFile)) {
      injected = true;
      const fd = originalOpen.call(fs, file, "wx", 0o600);
      try {
        fs.writeFileSync(fd, "{partial-owner", "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      const error = new Error("injected initialization failure after partial publication");
      error.code = "EIO";
      throw error;
    }
    return originalOpen.call(fs, file, ...args);
  };
  try {
    await assert.rejects(
      () => runOuterCycles({
        ...options(f),
        launchCycle: async () => {
          launches += 1;
          return {};
        },
      }),
      (error) => error?.code === "OUTER_RUN_LEASE_INITIALIZATION_FAILED" && error?.lease_residue_cleaned === false,
    );
  } finally {
    fs.openSync = originalOpen;
  }

  assert.equal(launches, 0);
  assert.equal(fs.existsSync(f.leaseDirectory), true);
  assert.equal(fs.existsSync(f.ownerFile), false);
  const entries = fs.readdirSync(f.leaseDirectory);
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^owner\.cleanup-.+\.json$/);
  assert.equal(fs.readFileSync(path.join(f.leaseDirectory, entries[0]), "utf8"), "{partial-owner");

  await assertAmbiguousOnRetry(f, { get count() { return launches; }, set count(value) { launches = value; } });
});
