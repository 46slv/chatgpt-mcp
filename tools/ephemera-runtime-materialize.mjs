import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  EPHEMERA_RUNTIME_BINDING,
  validateEphemeraRuntimeBinding,
} from "./ephemera-runtime-binding.mjs";

export const EPHEMERA_RUNTIME_MATERIALIZATION_SCHEMA = "ephemera.runtime-materialization/v1";
export const EPHEMERA_RUNTIME_CACHE_ENV = "EPHEMERA_RUNTIME_CACHE_DIR";
const LOADER_CONTENT = "export * from \"@46slv/ephemera-system-local-runtime\";\n";
const LOADER_SHA256 = crypto.createHash("sha256").update(LOADER_CONTENT).digest("hex");

function errorWithCode(message, code = "EPHEMERA_RUNTIME_MATERIALIZATION_BLOCKED") {
  const error = new Error(message);
  error.name = "EphemeraRuntimeMaterializationError";
  error.code = code;
  return error;
}

function fail(message, code) {
  throw errorWithCode(message, code);
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function regularFile(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() && !stat.isReparsePoint?.() && !(Number.isInteger(stat.nlink) && stat.nlink > 1);
  } catch {
    return false;
  }
}

function regularDirectory(directory) {
  try {
    const stat = fs.lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink() && !stat.isReparsePoint?.() && !(Number.isInteger(stat.nlink) && stat.nlink > 1);
  } catch {
    return false;
  }
}

function readJson(file, code) {
  if (!regularFile(file)) fail("materialized runtime metadata is missing", code);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fail("materialized runtime metadata is invalid", code);
  }
}

function pathIsInside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function nearestExistingPath(target) {
  let current = path.resolve(target);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function assertNoReparseComponents(target) {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  let current = root;
  for (const piece of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, piece);
    if (!fs.existsSync(current)) break;
    let stat;
    try { stat = fs.lstatSync(current); } catch { fail("runtime cache path could not be inspected", "EPHEMERA_CACHE_PATH_INVALID"); }
    if (stat.isSymbolicLink() || stat.isReparsePoint?.() || (Number.isInteger(stat.nlink) && stat.nlink > 1)) {
      fail("runtime cache path contains a link or reparse point", "EPHEMERA_CACHE_PATH_INVALID");
    }
  }
}

function assertExternalCache(cacheDir, worktree) {
  if (typeof worktree !== "string" || !worktree.trim()) fail("worktree is required to validate the runtime cache", "WORKTREE_REQUIRED");
  const resolved = path.resolve(cacheDir);
  if (resolved === path.parse(resolved).root) fail("runtime cache path is too broad", "EPHEMERA_CACHE_PATH_INVALID");
  assertNoReparseComponents(resolved);
  const worktreeResolved = path.resolve(worktree);
  const worktreeReal = fs.existsSync(worktreeResolved) ? fs.realpathSync.native(worktreeResolved) : worktreeResolved;
  const existing = nearestExistingPath(resolved);
  const existingReal = fs.realpathSync.native(existing);
  if (pathIsInside(resolved, worktreeResolved) || pathIsInside(existingReal, worktreeReal)) {
    fail("runtime cache must be outside the task worktree", "EPHEMERA_CACHE_INSIDE_WORKTREE");
  }
  if (fs.existsSync(resolved)) {
    const targetReal = fs.realpathSync.native(resolved);
    if (pathIsInside(targetReal, worktreeReal)) fail("runtime cache must be outside the task worktree", "EPHEMERA_CACHE_INSIDE_WORKTREE");
  }
}

export function defaultEphemeraRuntimeCacheDir(env = process.env) {
  const configured = env?.[EPHEMERA_RUNTIME_CACHE_ENV];
  if (typeof configured === "string" && configured.trim()) return path.resolve(configured);
  const base = env?.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.resolve(base, "ChatGPTMCPProbe", "ephemera-system-runtime-cache");
}

function packagePath(cacheDir, binding) {
  const [scope, name] = binding.package_name.slice(1).split("/");
  return path.join(cacheDir, "node_modules", `@${scope}`, name);
}

function expectedPackageMetadata(value, binding) {
  if (!isObject(value)
    || value.name !== binding.package_name
    || value.version !== binding.package_version
    || value.private !== true
    || value.type !== "module"
    || !isObject(value.exports)
    || Object.keys(value.exports).length !== 1
    || value.exports["."] !== "./tools/system-local-runtime-public.mjs") {
    fail("materialized package identity or exports do not match the exact binding", "EPHEMERA_PACKAGE_METADATA_MISMATCH");
  }
  return value;
}

function packageFileManifest(root) {
  if (!regularDirectory(root)) fail("materialized package root is unsafe", "EPHEMERA_PACKAGE_CONTENT_MISMATCH");
  const manifest = {};
  const visit = (directory, relativeDirectory = "") => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)); }
    catch { fail("materialized package content could not be read", "EPHEMERA_PACKAGE_CONTENT_MISMATCH"); }
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      let stat;
      try { stat = fs.lstatSync(absolute); } catch { fail("materialized package content could not be inspected", "EPHEMERA_PACKAGE_CONTENT_MISMATCH"); }
      if (entry.isSymbolicLink() || stat.isReparsePoint?.() || (Number.isInteger(stat.nlink) && stat.nlink > 1)) {
        fail("materialized package content contains a link", "EPHEMERA_PACKAGE_CONTENT_MISMATCH");
      }
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) {
        if (Object.keys(manifest).length >= 256) fail("materialized package content is out of bounds", "EPHEMERA_PACKAGE_CONTENT_MISMATCH");
        manifest[relative] = crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
      } else fail("materialized package content contains an unsupported entry", "EPHEMERA_PACKAGE_CONTENT_MISMATCH");
    }
  };
  visit(root);
  return manifest;
}

function manifestsMatch(actual, expected) {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index] && actual[key] === expected[key]);
}

function readMaterializedBinding(cacheDir, binding) {
  const metadata = readJson(path.join(cacheDir, "binding.json"), "EPHEMERA_RUNTIME_NOT_MATERIALIZED");
  const observed = metadata.binding || metadata;
  let normalized;
  try { normalized = validateEphemeraRuntimeBinding(observed); } catch { fail("materialized binding is invalid", "EPHEMERA_RUNTIME_BINDING_MISMATCH"); }
  const expected = validateEphemeraRuntimeBinding(binding);
  const matches = ["repository", "target_commit_sha", "package_name", "package_version", "artifact_sha256"]
    .every((key) => normalized[key] === expected[key]);
  if (!matches || !manifestsMatch(normalized.package_files, expected.package_files) || metadata.schema !== EPHEMERA_RUNTIME_MATERIALIZATION_SCHEMA) {
    fail("materialized binding does not match the exact consumer pin", "EPHEMERA_RUNTIME_BINDING_MISMATCH");
  }
  return normalized;
}

function verifyMaterializedCache(cacheDir, binding, { requireLoader = true } = {}) {
  const normalized = readMaterializedBinding(cacheDir, binding);
  const packageRoot = packagePath(cacheDir, normalized);
  const packageJson = readJson(path.join(packageRoot, "package.json"), "EPHEMERA_PACKAGE_NOT_MATERIALIZED");
  expectedPackageMetadata(packageJson, normalized);
  if (!manifestsMatch(packageFileManifest(packageRoot), normalized.package_files)) {
    fail("materialized package content does not match the exact binding", "EPHEMERA_PACKAGE_CONTENT_MISMATCH");
  }
  const facade = path.join(packageRoot, packageJson.exports["."]);
  if (!regularFile(facade)) fail("materialized package facade is missing", "EPHEMERA_PACKAGE_EXPORT_MISSING");
  const loader = path.join(cacheDir, "load-ephemera-runtime.mjs");
  if (requireLoader && !regularFile(loader)) fail("materialized package loader is missing", "EPHEMERA_PACKAGE_LOADER_MISSING");
  if (requireLoader) {
    const loaderSha = crypto.createHash("sha256").update(fs.readFileSync(loader)).digest("hex");
    const metadata = readJson(path.join(cacheDir, "binding.json"), "EPHEMERA_RUNTIME_NOT_MATERIALIZED");
    if (metadata.loader_sha256 !== LOADER_SHA256 || loaderSha !== LOADER_SHA256) {
      fail("materialized package loader content does not match cache metadata", "EPHEMERA_PACKAGE_LOADER_MISMATCH");
    }
  }
  return Object.freeze({ status: "READY", cacheDir: path.resolve(cacheDir), packageRoot, loader, binding: normalized, package: packageJson });
}

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    fail(`${command} could not materialize the exact runtime artifact`, "EPHEMERA_MATERIALIZATION_BLOCKED");
  }
  return String(result.stdout || "").trim();
}

function npmCliPath() {
  const configured = process.env.npm_execpath;
  if (typeof configured === "string" && configured.trim() && !/[.]cmd$|[.]ps1$/i.test(configured)) return path.resolve(configured);
  const bundled = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (regularFile(bundled)) return bundled;
  fail("npm executable is unavailable for explicit materialization", "EPHEMERA_MATERIALIZATION_BLOCKED");
}

function runNpm(args, cwd) {
  return runCommand(process.execPath, [npmCliPath(), ...args], cwd);
}

function parsePackOutput(raw) {
  try {
    const parsed = JSON.parse(raw);
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!isObject(entry) || typeof entry.filename !== "string" || typeof entry.name !== "string" || typeof entry.version !== "string") throw new Error();
    return entry;
  } catch {
    fail("npm pack did not return bounded JSON metadata", "EPHEMERA_ARTIFACT_METADATA_INVALID");
  }
}

function sha256File(file) {
  if (!regularFile(file)) fail("packed runtime artifact is missing", "EPHEMERA_ARTIFACT_MISSING");
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function cleanupDirectory(directory) {
  try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* generated temporary directory only */ }
}

function writeMaterializationFiles(stage, binding) {
  fs.writeFileSync(path.join(stage, "package.json"), `${JSON.stringify({ name: "chatgpt-mcp-ephemera-runtime-cache", private: true, type: "module" }, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(stage, "load-ephemera-runtime.mjs"), LOADER_CONTENT, "utf8");
  fs.writeFileSync(path.join(stage, "binding.json"), `${JSON.stringify({ schema: EPHEMERA_RUNTIME_MATERIALIZATION_SCHEMA, binding, loader_sha256: LOADER_SHA256 }, null, 2)}\n`, "utf8");
}

/**
 * Explicit setup boundary for the private package.  This function is never
 * called by default/cloud selection; callers must invoke it deliberately.
 */
export async function materializeEphemeraRuntime({
  cacheDir = defaultEphemeraRuntimeCacheDir(),
  binding = EPHEMERA_RUNTIME_BINDING,
  worktree = process.cwd(),
} = {}) {
  const expected = validateEphemeraRuntimeBinding(binding);
  const target = path.resolve(cacheDir);
  assertExternalCache(target, worktree);

  if (fs.existsSync(target)) return verifyMaterializedCache(target, expected);

  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "ephemera-system-source-"));
  const stage = fs.mkdtempSync(path.join(parent, ".ephemera-runtime-stage-"));
  try {
    runCommand("git", ["init", "--quiet"], source);
    // Package bytes must not depend on a Windows user's global autocrlf
    // setting.  Pack from the exact Git blob bytes (LF) on every platform.
    runCommand("git", ["config", "core.autocrlf", "false"], source);
    runCommand("git", ["config", "core.eol", "lf"], source);
    runCommand("git", ["remote", "add", "origin", `https://github.com/${expected.repository}.git`], source);
    runCommand("git", ["fetch", "--depth", "1", "--no-tags", "origin", expected.target_commit_sha], source);
    runCommand("git", ["checkout", "--detach", "FETCH_HEAD"], source);
    const actualCommit = runCommand("git", ["rev-parse", "HEAD"], source).toLowerCase();
    if (actualCommit !== expected.target_commit_sha) fail("exact System commit could not be verified", "EPHEMERA_COMMIT_MISMATCH");

    const sourcePackage = readJson(path.join(source, "package.json"), "EPHEMERA_SOURCE_PACKAGE_MISSING");
    expectedPackageMetadata(sourcePackage, expected);
    const packRaw = runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", source], source);
    const pack = parsePackOutput(packRaw);
    if (pack.name !== expected.package_name || pack.version !== expected.package_version) fail("packed artifact identity does not match the exact binding", "EPHEMERA_ARTIFACT_METADATA_MISMATCH");
    const artifact = path.resolve(source, pack.filename);
    const artifactSha = sha256File(artifact);
    if (artifactSha !== expected.artifact_sha256) fail("packed artifact SHA-256 does not match the exact binding", "EPHEMERA_ARTIFACT_MISMATCH");

    runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", artifact], stage);
    writeMaterializationFiles(stage, expected);
    verifyMaterializedCache(stage, expected);
    const imported = await import(`${pathToFileURL(path.join(stage, "load-ephemera-runtime.mjs")).href}?probe=${expected.target_commit_sha}`);
    if (typeof imported.createSystemLocalRuntimeLifecycle !== "function" || typeof imported.scanRecoveryState !== "function") {
      fail("packed facade import did not expose the documented lifecycle API", "EPHEMERA_EXPORTS_MISMATCH");
    }

    try { fs.renameSync(stage, target); }
    catch {
      if (!fs.existsSync(target)) fail("runtime cache could not be installed atomically", "EPHEMERA_CACHE_INSTALL_FAILED");
      cleanupDirectory(stage);
    }
    return verifyMaterializedCache(target, expected);
  } finally {
    cleanupDirectory(source);
    if (fs.existsSync(stage)) cleanupDirectory(stage);
  }
}

/** Load only the package root through the cache-local package-root loader. */
export async function loadEphemeraRuntimePackage({
  cacheDir = defaultEphemeraRuntimeCacheDir(),
  binding = EPHEMERA_RUNTIME_BINDING,
  worktree = process.cwd(),
} = {}) {
  const expected = validateEphemeraRuntimeBinding(binding);
  const target = path.resolve(cacheDir);
  assertExternalCache(target, worktree);
  const verified = verifyMaterializedCache(target, expected);
  try {
    return await import(`${pathToFileURL(verified.loader).href}?binding=${expected.target_commit_sha}`);
  } catch {
    fail("materialized EPHEMERA package root could not be imported", "EPHEMERA_PACKAGE_IMPORT_BLOCKED");
  }
}

function cliArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cache-dir" || arg === "--worktree") {
      const value = argv[++index];
      if (!value) fail(`${arg} requires a value`, "EPHEMERA_MATERIALIZATION_USAGE");
      values[arg.slice(2)] = value;
    } else {
      fail(`unknown materialization argument: ${arg}`, "EPHEMERA_MATERIALIZATION_USAGE");
    }
  }
  return values;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    const values = cliArguments(process.argv.slice(2));
    const result = await materializeEphemeraRuntime({ cacheDir: values["cache-dir"], worktree: values.worktree || process.cwd() });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = 0;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: "BLOCKED", code: error?.code || "EPHEMERA_RUNTIME_MATERIALIZATION_BLOCKED", message: String(error?.message || error) }, null, 2)}\n`);
    process.exitCode = 2;
  }
}
