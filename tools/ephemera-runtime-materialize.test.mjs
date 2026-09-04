import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EPHEMERA_RUNTIME_BINDING,
  validateEphemeraRuntimeBinding,
} from "./ephemera-runtime-binding.mjs";
import {
  defaultEphemeraRuntimeCacheDir,
  loadEphemeraRuntimePackage,
  materializeEphemeraRuntime,
} from "./ephemera-runtime-materialize.mjs";

const REAL_CACHE = process.env.EPHEMERA_RUNTIME_TEST_CACHE_DIR || "";

test("binding fixes repository, exact commit, package identity, and artifact SHA-256", () => {
  const binding = validateEphemeraRuntimeBinding();
  assert.equal(binding.repository, "46slv/EPHEMERA-System");
  assert.equal(binding.target_commit_sha.length, 40);
  assert.equal(binding.package_name, "@46slv/ephemera-system-local-runtime");
  assert.equal(binding.package_version, "0.1.0");
  assert.equal(binding.artifact_sha256.length, 64);
  assert.equal(Object.keys(binding.package_files).length, 10);
  assert.deepEqual(binding, EPHEMERA_RUNTIME_BINDING);
});

test("unmaterialized package is BLOCKED and never falls back to source", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ephemera-unmaterialized-"));
  const cache = path.join(path.dirname(root), `${path.basename(root)}-missing-cache`);
  await assert.rejects(
    () => loadEphemeraRuntimePackage({ cacheDir: cache, worktree: root }),
    (error) => error.code === "EPHEMERA_RUNTIME_NOT_MATERIALIZED",
  );
});

test("cache path inside the task worktree is rejected before any materialization", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ephemera-cache-boundary-"));
  await assert.rejects(
    () => materializeEphemeraRuntime({ cacheDir: path.join(root, "runtime-cache"), worktree: root }),
    (error) => error.code === "EPHEMERA_CACHE_INSIDE_WORKTREE",
  );
});

test("default cache is machine-local and external to a supplied worktree", () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "ephemera-cache-default-"));
  const cache = defaultEphemeraRuntimeCacheDir({});
  const relative = path.relative(worktree, cache);
  assert.notEqual(relative, "");
  assert.equal(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), true);
});

test("materialized cache reuse rejects package or loader content tampering", { skip: !REAL_CACHE }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ephemera-cache-tamper-"));
  const cache = path.join(root, "cache");
  fs.cpSync(REAL_CACHE, cache, { recursive: true });
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "ephemera-cache-tamper-worktree-"));
  const packageFile = path.join(cache, "node_modules", "@46slv", "ephemera-system-local-runtime", "tools", "local-runtime-lifecycle.mjs");
  const original = fs.readFileSync(packageFile);
  fs.appendFileSync(packageFile, "\n// tamper probe\n");
  await assert.rejects(
    () => loadEphemeraRuntimePackage({ cacheDir: cache, worktree }),
    (error) => error.code === "EPHEMERA_PACKAGE_CONTENT_MISMATCH",
  );
  fs.writeFileSync(packageFile, original);
  const unexpected = path.join(cache, "node_modules", "@46slv", "ephemera-system-local-runtime", "tools", "unexpected.mjs");
  fs.writeFileSync(unexpected, "export {};\n", "utf8");
  await assert.rejects(
    () => loadEphemeraRuntimePackage({ cacheDir: cache, worktree }),
    (error) => error.code === "EPHEMERA_PACKAGE_CONTENT_MISMATCH",
  );
  fs.rmSync(unexpected, { force: true });
  const loader = path.join(cache, "load-ephemera-runtime.mjs");
  const loaderOriginal = fs.readFileSync(loader);
  fs.appendFileSync(loader, "\n// tamper probe\n");
  await assert.rejects(
    () => loadEphemeraRuntimePackage({ cacheDir: cache, worktree }),
    (error) => error.code === "EPHEMERA_PACKAGE_LOADER_MISMATCH",
  );
  fs.writeFileSync(loader, loaderOriginal);
  await assert.doesNotReject(() => loadEphemeraRuntimePackage({ cacheDir: cache, worktree }));
});
