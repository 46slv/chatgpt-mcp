import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  OUTER_SCHEMA,
  createHarnessLauncher,
  createOuterReceipt,
  dedupeOuterCycle,
  runOuterCycles as runOuterCyclesCore,
  verifyHarnessBinding,
} from "./devexec-harness-adapter-core.mjs";

export { OUTER_SCHEMA, createHarnessLauncher, createOuterReceipt, dedupeOuterCycle, verifyHarnessBinding };

const SHA40 = /^[0-9a-f]{40}$/;
const OUTER_LEASE_SCHEMA = "devexec.harness-outer-lease.v1";
const OUTER_LEASE_KEYS = [
  "schema",
  "owner_token",
  "process_id",
  "receipt_file",
  "outer_run_id",
  "goal_identity",
  "task_identity",
  "project_adapter",
  "harness_commit_sha",
  "target_base_sha",
  "target_ref",
  "acquired_at",
];

const requiredString = (value, label) => {
  if (typeof value !== "string" || !value) throw new Error(`${label} required`);
  return value;
};

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}_INVALID`);
  return value;
}

function rejectUnknown(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label}_UNKNOWN_FIELD:${unknown[0]}`);
}

function requireFields(value, required, label) {
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`${label}_REQUIRED_FIELD_MISSING:${key}`);
}

function requireDateTime(value, label) {
  requiredString(value, label);
  if (Number.isNaN(Date.parse(value))) throw new Error(`${label}_INVALID`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function canonicalReceiptPath(receiptFile) {
  requiredString(receiptFile, "receiptFile");
  const resolved = path.resolve(receiptFile);
  const parent = path.dirname(resolved);
  fs.mkdirSync(parent, { recursive: true });
  const canonical = path.join(fs.realpathSync(parent), path.basename(resolved));
  if (fs.existsSync(canonical) && fs.lstatSync(canonical).isSymbolicLink()) throw new Error("OUTER_RECEIPT_SYMLINK_FORBIDDEN");
  return canonical;
}

function expectedLeaseIdentity(args) {
  requireObject(args, "OUTER_RUN_ARGS");
  const receiptFile = requiredString(args.receiptFile, "receiptFile");
  const outer_run_id = requiredString(args.outer_run_id, "outer_run_id");
  const goal_identity = requiredString(args.goal_identity, "goal_identity");
  const task_identity = requiredString(args.task_identity, "task_identity");
  const project_adapter = args.project_adapter === undefined ? "json" : requiredString(args.project_adapter, "project_adapter");
  const maxCycles = args.maxCycles === undefined ? 2 : args.maxCycles;
  if (!Number.isInteger(maxCycles) || maxCycles < 1 || maxCycles > 64) throw new Error("maxCycles must be an integer in [1,64]");
  const binding = verifyHarnessBinding(args.binding);
  return { receiptFile, outer_run_id, goal_identity, task_identity, project_adapter, maxCycles, binding };
}

function validateLeaseOwner(owner, expected, receiptFile) {
  requireObject(owner, "OUTER_RUN_LEASE_OWNER");
  rejectUnknown(owner, OUTER_LEASE_KEYS, "OUTER_RUN_LEASE_OWNER");
  requireFields(owner, OUTER_LEASE_KEYS, "OUTER_RUN_LEASE_OWNER");
  if (owner.schema !== OUTER_LEASE_SCHEMA) throw new Error("OUTER_RUN_LEASE_SCHEMA_MISMATCH");
  requiredString(owner.owner_token, "lease.owner_token");
  if (!Number.isInteger(owner.process_id) || owner.process_id <= 0) throw new Error("OUTER_RUN_LEASE_PROCESS_INVALID");
  if (owner.receipt_file !== receiptFile) throw new Error("OUTER_RUN_LEASE_RECEIPT_MISMATCH");
  for (const key of ["outer_run_id", "goal_identity", "task_identity", "project_adapter"]) {
    requiredString(owner[key], `lease.${key}`);
    if (owner[key] !== expected[key]) throw new Error(`OUTER_RUN_LEASE_IDENTITY_MISMATCH:${key}`);
  }
  if (!SHA40.test(owner.harness_commit_sha || "") || owner.harness_commit_sha !== expected.binding.harness_commit_sha) {
    throw new Error("OUTER_RUN_LEASE_HARNESS_MISMATCH");
  }
  if (!SHA40.test(owner.target_base_sha || "") || owner.target_base_sha !== expected.binding.target_base_sha) {
    throw new Error("OUTER_RUN_LEASE_TARGET_MISMATCH");
  }
  if (owner.target_ref !== expected.binding.target_ref) throw new Error("OUTER_RUN_LEASE_TARGET_REF_MISMATCH");
  requireDateTime(owner.acquired_at, "OUTER_RUN_LEASE_ACQUIRED_AT");
  return owner;
}

function acquireOuterLease(expected) {
  const canonicalReceipt = canonicalReceiptPath(expected.receiptFile);
  const leaseDirectory = `${canonicalReceipt}.lease`;
  const ownerFile = path.join(leaseDirectory, "owner.json");
  try {
    fs.mkdirSync(leaseDirectory, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    try {
      validateLeaseOwner(readJson(ownerFile), expected, canonicalReceipt);
    } catch (ownerError) {
      const ambiguous = new Error("OUTER_RUN_LEASE_AMBIGUOUS");
      ambiguous.code = "OUTER_RUN_LEASE_AMBIGUOUS";
      ambiguous.cause = ownerError;
      throw ambiguous;
    }
    const held = new Error("OUTER_RUN_LEASE_HELD");
    held.code = "OUTER_RUN_LEASE_HELD";
    throw held;
  }

  const owner = {
    schema: OUTER_LEASE_SCHEMA,
    owner_token: crypto.randomUUID(),
    process_id: process.pid,
    receipt_file: canonicalReceipt,
    outer_run_id: expected.outer_run_id,
    goal_identity: expected.goal_identity,
    task_identity: expected.task_identity,
    project_adapter: expected.project_adapter,
    harness_commit_sha: expected.binding.harness_commit_sha,
    target_base_sha: expected.binding.target_base_sha,
    target_ref: expected.binding.target_ref,
    acquired_at: new Date().toISOString(),
  };
  validateLeaseOwner(owner, expected, canonicalReceipt);
  try {
    const fd = fs.openSync(ownerFile, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(owner, null, 2)}\n`, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    const failed = new Error("OUTER_RUN_LEASE_INITIALIZATION_FAILED");
    failed.code = "OUTER_RUN_LEASE_INITIALIZATION_FAILED";
    failed.cause = error;
    throw failed;
  }
  return { canonicalReceipt, leaseDirectory, ownerFile, owner };
}

function assertOuterLeaseOwner(lease, expected) {
  let current;
  try {
    current = validateLeaseOwner(readJson(lease.ownerFile), expected, lease.canonicalReceipt);
  } catch (error) {
    const ambiguous = new Error("OUTER_RUN_LEASE_OWNERSHIP_AMBIGUOUS");
    ambiguous.code = "OUTER_RUN_LEASE_OWNERSHIP_AMBIGUOUS";
    ambiguous.cause = error;
    throw ambiguous;
  }
  if (current.owner_token !== lease.owner.owner_token) {
    const lost = new Error("OUTER_RUN_LEASE_OWNERSHIP_LOST");
    lost.code = "OUTER_RUN_LEASE_OWNERSHIP_LOST";
    throw lost;
  }
}

function releaseOuterLease(lease, expected) {
  assertOuterLeaseOwner(lease, expected);
  fs.unlinkSync(lease.ownerFile);
  fs.rmdirSync(lease.leaseDirectory);
}

export async function runOuterCycles(args) {
  const expected = expectedLeaseIdentity(args);
  const lease = acquireOuterLease(expected);
  try {
    assertOuterLeaseOwner(lease, expected);
    return await runOuterCyclesCore(args);
  } finally {
    releaseOuterLease(lease, expected);
  }
}
