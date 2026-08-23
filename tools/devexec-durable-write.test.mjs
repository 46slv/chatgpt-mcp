import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  durableWriteJsonAtomic,
  durableWriteTextAtomic,
  syncDirectoryDurably,
} from "./devexec-durable-write.mjs";

function makeRoot(label) {
  return fs.mkdtempSync(
    path.join(os.tmpdir(), `devexec-durable-${label}-`),
  );
}

function tracingFs(events, {
  failSync = false,
  failRename = false,
} = {}) {
  const names = new Map();

  return {
    existsSync: fs.existsSync.bind(fs),
    mkdirSync: fs.mkdirSync.bind(fs),

    openSync(file, flags, mode) {
      const fd = fs.openSync(file, flags, mode);
      names.set(fd, path.resolve(file));
      events.push(`open:${names.get(fd)}`);
      return fd;
    },

    writeFileSync(fd, data, encoding) {
      events.push(`write:${names.get(fd)}`);
      return fs.writeFileSync(fd, data, encoding);
    },

    fsyncSync(fd) {
      const name = names.get(fd);
      events.push(`sync:${name}`);

      if (failSync && name?.includes(".tmp-")) {
        const error = new Error("injected sync failure");
        error.code = "EIO";
        throw error;
      }

      return fs.fsyncSync(fd);
    },

    closeSync(fd) {
      events.push(`close:${names.get(fd)}`);
      names.delete(fd);
      return fs.closeSync(fd);
    },

    renameSync(from, to) {
      events.push(`rename:${path.resolve(from)}=>${path.resolve(to)}`);

      if (failRename) {
        const error = new Error("injected publish failure");
        error.code = "EIO";
        throw error;
      }

      return fs.renameSync(from, to);
    },
  };
}

test("temporary bytes are fsynced before atomic rename", () => {
  const root = makeRoot("order");
  const target = path.join(root, "state.json");
  const events = [];

  durableWriteJsonAtomic(
    target,
    {revision: 1},
    {
      fsImpl: tracingFs(events),
      allowUnsupportedDirectorySync: true,
      token: "order",
    },
  );

  const syncIndex = events.findIndex(
    event => event.startsWith("sync:") && event.includes(".tmp-order"),
  );

  const renameIndex = events.findIndex(
    event => event.startsWith("rename:"),
  );

  assert.ok(syncIndex >= 0, events.join("\n"));
  assert.ok(renameIndex > syncIndex, events.join("\n"));
  assert.deepEqual(
    JSON.parse(fs.readFileSync(target, "utf8")),
    {revision: 1},
  );
});

test("file sync failure prevents canonical publication", () => {
  const root = makeRoot("sync-failure");
  const target = path.join(root, "state.json");
  const events = [];

  assert.throws(
    () => durableWriteTextAtomic(
      target,
      "new\n",
      {
        fsImpl: tracingFs(events, {failSync: true}),
        allowUnsupportedDirectorySync: true,
        token: "sync-failure",
      },
    ),
    /injected sync failure/,
  );

  assert.equal(fs.existsSync(target), false);
  assert.equal(
    events.some(event => event.startsWith("rename:")),
    false,
  );
});

test("failed atomic rename leaves existing canonical bytes unchanged", () => {
  const root = makeRoot("rename-failure");
  const target = path.join(root, "state.json");

  fs.writeFileSync(target, "old\n", "utf8");

  const events = [];

  assert.throws(
    () => durableWriteTextAtomic(
      target,
      "new\n",
      {
        fsImpl: tracingFs(events, {failRename: true}),
        allowUnsupportedDirectorySync: true,
        token: "rename-failure",
      },
    ),
    /injected publish failure/,
  );

  assert.equal(fs.readFileSync(target, "utf8"), "old\n");
});

test("host directory sync capability is explicitly classified", () => {
  const root = makeRoot("directory");

  const result = syncDirectoryDurably(root, {
    allowUnsupported: true,
  });

  assert.ok(
    result.status === "SYNCED" ||
    result.status === "UNSUPPORTED",
    JSON.stringify(result),
  );

  console.log(
    `HOST_DIRECTORY_SYNC_TEST_STATUS=${result.status}`,
  );

  console.log(
    `HOST_DIRECTORY_SYNC_TEST_CODE=${result.code ?? "NONE"}`,
  );
});
