import fs from "node:fs";
import path from "node:path";

const UNSUPPORTED_DIRECTORY_SYNC = new Set([
  "EINVAL",
  "ENOTSUP",
  "ENOSYS",
  "EPERM",
  "EACCES",
  "EISDIR",
]);

export function syncDirectoryDurably(directory, {
  fsImpl = fs,
  allowUnsupported = process.platform === "win32",
} = {}) {
  const resolved = path.resolve(directory);
  let fd = null;

  try {
    fd = fsImpl.openSync(resolved, "r");
    fsImpl.fsyncSync(fd);

    return {
      status: "SYNCED",
      code: null,
      directory: resolved,
    };
  } catch (error) {
    if (
      allowUnsupported &&
      UNSUPPORTED_DIRECTORY_SYNC.has(error?.code)
    ) {
      return {
        status: "UNSUPPORTED",
        code: error.code,
        directory: resolved,
      };
    }

    const failure = new Error("DEVEXEC_DIRECTORY_SYNC_FAILED");
    failure.cause = error;
    failure.fs_code = error?.code ?? null;
    failure.directory = resolved;
    throw failure;
  } finally {
    if (fd != null) {
      try {
        fsImpl.closeSync(fd);
      } catch {}
    }
  }
}

export function durableWriteTextAtomic(file, text, {
  fsImpl = fs,
  allowUnsupportedDirectorySync = process.platform === "win32",
  token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
} = {}) {
  const target = path.resolve(file);
  const directory = path.dirname(target);

  fsImpl.mkdirSync(directory, {recursive: true});

  const temporary = `${target}.tmp-${token}`;
  let fd = null;

  try {
    fd = fsImpl.openSync(temporary, "wx", 0o600);
    fsImpl.writeFileSync(fd, text, "utf8");
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
    fd = null;

    fsImpl.renameSync(temporary, target);

    const directorySync = syncDirectoryDurably(directory, {
      fsImpl,
      allowUnsupported: allowUnsupportedDirectorySync,
    });

    return {
      file: target,
      directory_sync: directorySync.status,
      directory_sync_code: directorySync.code,
    };
  } catch (error) {
    if (fd != null) {
      try {
        fsImpl.closeSync(fd);
      } catch {}
    }

    throw error;
  }
}

export function durableWriteJsonAtomic(file, value, options = {}) {
  return durableWriteTextAtomic(
    file,
    JSON.stringify(value, null, 2) + "\n",
    options,
  );
}
