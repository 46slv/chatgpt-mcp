import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  controlReceiptPath,
  inspectControlLifecycle,
  statusControlServer,
  stopControlServer,
} from "./devexec-control.mjs";

function fixture() {
  const root =
    fs.mkdtempSync(
      path.join(
        os.tmpdir(),
        "devexec-control-stale-",
      ),
    );

  const env = {
    ...process.env,
    LOCALAPPDATA: root,
  };

  return {
    root,
    env,
    receipt: controlReceiptPath(env),
  };
}

function writeStaleReceipt(fx) {
  fs.mkdirSync(
    path.dirname(fx.receipt),
    {recursive: true},
  );

  fs.writeFileSync(
    fx.receipt,
    JSON.stringify(
      {
        protocol: "devexec.control.host",
        schema_version: 1,
        pid: 2147483647,
        host: "127.0.0.1",
        port: 65530,
        url: "http://127.0.0.1:65530",
        gui_url: "http://127.0.0.1:65530/ui",
        base: fx.root,
        started_at: "2000-01-01T00:00:00.000Z",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

test(
  "status classifies a dead lifecycle receipt as stale rather than running",
  () => {
    const fx = fixture();

    try {
      writeStaleReceipt(fx);

      const inspected =
        inspectControlLifecycle({
          env: fx.env,
        });

      assert.equal(
        inspected.running,
        false,
      );

      assert.equal(
        inspected.stale,
        true,
      );

      const status =
        statusControlServer({
          env: fx.env,
        });

      assert.equal(
        status.running,
        false,
      );

      assert.equal(
        status.stale,
        true,
      );
    } finally {
      fs.rmSync(
        fx.root,
        {
          recursive: true,
          force: true,
        },
      );
    }
  },
);

test(
  "stop clears a stale receipt without signaling an unrelated process",
  async () => {
    const fx = fixture();

    try {
      writeStaleReceipt(fx);

      let killCalls = 0;

      const result =
        await stopControlServer({
          env: fx.env,

          kill_process() {
            killCalls += 1;
            throw new Error(
              "must not signal stale pid"
            );
          },
        });

      assert.equal(
        result.already_stopped,
        true,
      );

      assert.equal(
        result.stale_receipt,
        true,
      );

      assert.equal(
        killCalls,
        0,
      );

      assert.equal(
        fs.existsSync(fx.receipt),
        false,
      );
    } finally {
      fs.rmSync(
        fx.root,
        {
          recursive: true,
          force: true,
        },
      );
    }
  },
);
