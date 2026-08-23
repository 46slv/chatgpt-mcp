import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

function rawTreeError(code, details = {}) {
  const error = new Error(code);
  Object.assign(error, details);
  return error;
}

function gitObjectSha1(type, body) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const header = Buffer.from(`${type} ${payload.length}\0`, "utf8");
  return crypto.createHash("sha1").update(header).update(payload).digest();
}

function gitSortKey(name, isDirectory) {
  return Buffer.concat([
    Buffer.from(name, "utf8"),
    Buffer.from(isDirectory ? "/" : "\0", "binary"),
  ]);
}

function compareGitNames(a, b) {
  return Buffer.compare(gitSortKey(a.name, a.isDirectory), gitSortKey(b.name, b.isDirectory));
}

function regularFileMode(stat) {
  if (process.platform === "win32") return "100644";
  return (stat.mode & 0o111) !== 0 ? "100755" : "100644";
}

function walkTree(directory, {ignoreNames}) {
  const entries = [];
  let fileCount = 0;
  let byteCount = 0;

  for (const dirent of fs.readdirSync(directory, {withFileTypes: true})) {
    if (ignoreNames.has(dirent.name)) continue;
    const absolute = path.join(directory, dirent.name);

    if (dirent.isDirectory()) {
      const child = walkTree(absolute, {ignoreNames});
      if (child.entryCount === 0) continue;
      entries.push({
        name: dirent.name,
        isDirectory: true,
        mode: "40000",
        sha: child.sha,
      });
      fileCount += child.fileCount;
      byteCount += child.byteCount;
      continue;
    }

    if (dirent.isSymbolicLink()) {
      const target = Buffer.from(fs.readlinkSync(absolute), "utf8");
      entries.push({
        name: dirent.name,
        isDirectory: false,
        mode: "120000",
        sha: gitObjectSha1("blob", target),
      });
      fileCount += 1;
      byteCount += target.length;
      continue;
    }

    if (!dirent.isFile()) {
      throw rawTreeError("MISSION_RAW_SNAPSHOT_UNSUPPORTED_ENTRY", {
        path: absolute,
      });
    }

    const bytes = fs.readFileSync(absolute);
    const stat = fs.statSync(absolute);
    entries.push({
      name: dirent.name,
      isDirectory: false,
      mode: regularFileMode(stat),
      sha: gitObjectSha1("blob", bytes),
    });
    fileCount += 1;
    byteCount += bytes.length;
  }

  entries.sort(compareGitNames);
  const bodyParts = [];
  for (const entry of entries) {
    bodyParts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, "utf8"));
    bodyParts.push(entry.sha);
  }
  const body = Buffer.concat(bodyParts);
  return {
    sha: gitObjectSha1("tree", body),
    entryCount: entries.length,
    fileCount,
    byteCount,
  };
}

function canonicalDirectory(root) {
  if (typeof root !== "string" || !root.trim()) {
    throw rawTreeError("MISSION_RAW_SNAPSHOT_ROOT_REQUIRED");
  }
  const resolved = path.resolve(root);
  let real;
  try {
    real = typeof fs.realpathSync.native === "function"
      ? fs.realpathSync.native(resolved)
      : fs.realpathSync(resolved);
  } catch (cause) {
    throw rawTreeError("MISSION_RAW_SNAPSHOT_ROOT_UNAVAILABLE", {cause, root: resolved});
  }
  if (!fs.statSync(real).isDirectory()) {
    throw rawTreeError("MISSION_RAW_SNAPSHOT_ROOT_NOT_DIRECTORY", {root: real});
  }
  return real;
}

function normalizeSha1(value, code) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw rawTreeError(code, {value});
  }
  return normalized;
}

export function computeRawSnapshotGitTree(root, {ignoreNames = [".git"]} = {}) {
  const canonicalRoot = canonicalDirectory(root);
  const ignored = new Set(ignoreNames);
  const result = walkTree(canonicalRoot, {ignoreNames: ignored});
  return {
    root: canonicalRoot,
    tree_sha1: result.sha.toString("hex"),
    file_count: result.fileCount,
    byte_count: result.byteCount,
    ignored_names: [...ignored].sort(),
  };
}

export function verifyRawSnapshotGitTree(root, {
  expectedTree,
  expectedCommit = null,
  ignoreNames = [".git"],
} = {}) {
  const expected_tree = normalizeSha1(expectedTree, "MISSION_RAW_SNAPSHOT_EXPECTED_TREE_INVALID");
  const expected_commit = expectedCommit == null
    ? null
    : normalizeSha1(expectedCommit, "MISSION_RAW_SNAPSHOT_EXPECTED_COMMIT_INVALID");
  const observed = computeRawSnapshotGitTree(root, {ignoreNames});
  if (observed.tree_sha1 !== expected_tree) {
    throw rawTreeError("MISSION_RAW_SNAPSHOT_TREE_MISMATCH", {
      expected_tree,
      observed_tree: observed.tree_sha1,
      root: observed.root,
      file_count: observed.file_count,
      byte_count: observed.byte_count,
    });
  }
  return {
    protocol: "devexec.mission-raw-snapshot-tree",
    schema_version: 1,
    source_mode: "raw_snapshot",
    expected_commit,
    expected_tree,
    observed_tree: observed.tree_sha1,
    root: observed.root,
    file_count: observed.file_count,
    byte_count: observed.byte_count,
    ignored_names: observed.ignored_names,
    tree_identity: "PASS",
  };
}

function parseCli(argv) {
  let root = "";
  let expectedTree = "";
  let expectedCommit = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") root = argv[++i] ?? "";
    else if (arg === "--expected-tree") expectedTree = argv[++i] ?? "";
    else if (arg === "--expected-commit") expectedCommit = argv[++i] ?? "";
    else throw rawTreeError("MISSION_RAW_SNAPSHOT_UNKNOWN_ARGUMENT", {argument: arg});
  }
  return {root, expectedTree, expectedCommit};
}

const isMain = process.argv[1]
  ? path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
  : false;

if (isMain) {
  try {
    const options = parseCli(process.argv.slice(2));
    const report = verifyRawSnapshotGitTree(options.root, options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write("MISSION_RAW_SNAPSHOT_TREE=PASS\n");
  } catch (error) {
    const report = {
      protocol: "devexec.mission-raw-snapshot-tree-error",
      schema_version: 1,
      error: error?.message || String(error),
      expected_tree: error?.expected_tree ?? null,
      observed_tree: error?.observed_tree ?? null,
      root: error?.root ?? null,
      file_count: error?.file_count ?? null,
      byte_count: error?.byte_count ?? null,
    };
    process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 2;
  }
}
