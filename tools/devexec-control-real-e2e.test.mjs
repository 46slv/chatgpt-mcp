import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  startControlServer,
  statusControlServer,
  stopControlServer,
} from "./devexec-control.mjs";

test(
  "lifecycle starts loopback server, serves health/UI, deduplicates start, and stops",
  async () => {
    const root =
      fs.mkdtempSync(
        path.join(
          os.tmpdir(),
          "devexec-control-real-",
        ),
      );

    const env = {
      ...process.env,
      LOCALAPPDATA: root,
    };

    try {
      const started =
        await startControlServer({
          base: root,
          env,
          port: 0,
        });

      assert.equal(
        started.host,
        "127.0.0.1",
      );

      assert.equal(
        started.already_running,
        false,
      );

      const status =
        statusControlServer({
          env,
        });

      assert.equal(
        status.running,
        true,
      );

      assert.equal(
        status.receipt.pid,
        started.pid,
      );

      const health =
        await fetch(
          started.url + "/health",
        );

      assert.equal(
        health.status,
        200,
      );

      const healthBody =
        await health.json();

      assert.equal(
        healthBody.bind_policy,
        "loopback-only",
      );

      const gui =
        await fetch(
          started.gui_url,
        );

      assert.equal(
        gui.status,
        200,
      );

      assert.match(
        await gui.text(),
        /Dev Exec Control/,
      );

      const duplicate =
        await startControlServer({
          base: root,
          env,
          port: 0,
        });

      assert.equal(
        duplicate.already_running,
        true,
      );

      assert.equal(
        duplicate.pid,
        started.pid,
      );

      const stopped =
        await stopControlServer({
          env,
        });

      assert.equal(
        stopped.stopped,
        true,
      );

      const finalStatus =
        statusControlServer({
          env,
        });

      assert.equal(
        finalStatus.running,
        false,
      );
    } finally {
      try {
        await stopControlServer({
          env,
        });
      } catch {
      }

      fs.rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      );
    }
  },
);
