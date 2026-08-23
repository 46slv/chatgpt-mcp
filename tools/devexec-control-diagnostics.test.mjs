import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  controlReceiptPath,
  diagnoseControlServer,
} from "./devexec-control.mjs";

function fixture() {
  const root =
    fs.mkdtempSync(
      path.join(
        os.tmpdir(),
        "devexec-control-doctor-",
      ),
    );

  const env = {
    ...process.env,
    LOCALAPPDATA: root,
  };

  return {
    root,
    env,
    receipt:
      controlReceiptPath(env),
  };
}

function writeReceipt(
  fx,
  {
    pid,
    port = 60123,
  },
) {
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
        pid,
        host: "127.0.0.1",
        port,
        url: `http://127.0.0.1:${port}`,
        gui_url: `http://127.0.0.1:${port}/ui`,
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
  "doctor reports STOPPED without a receipt",
  async () => {
    const fx = fixture();

    try {
      const result =
        await diagnoseControlServer({
          env: fx.env,
          fetch_impl() {
            throw new Error(
              "must not fetch"
            );
          },
        });

      assert.equal(
        result.status,
        "STOPPED",
      );

      assert.equal(
        result.recommendation,
        "start",
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
  "doctor reports STALE without a health request",
  async () => {
    const fx = fixture();

    try {
      writeReceipt(
        fx,
        {
          pid: 2147483647,
        },
      );

      let fetchCalls = 0;

      const result =
        await diagnoseControlServer({
          env: fx.env,

          fetch_impl() {
            fetchCalls += 1;
            throw new Error(
              "must not fetch"
            );
          },
        });

      assert.equal(
        result.status,
        "STALE",
      );

      assert.equal(
        result.safe_cleanup_available,
        true,
      );

      assert.equal(
        result.recommendation,
        "stop",
      );

      assert.equal(
        fetchCalls,
        0,
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
  "doctor reports HEALTHY for valid live loopback health",
  async () => {
    const fx = fixture();

    try {
      writeReceipt(
        fx,
        {
          pid: process.pid,
        },
      );

      const result =
        await diagnoseControlServer({
          env: fx.env,

          async fetch_impl() {
            return {
              ok: true,
              status: 200,

              async json() {
                return {
                  status: "ok",
                  bind_policy:
                    "loopback-only",
                };
              },
            };
          },
        });

      assert.equal(
        result.status,
        "HEALTHY",
      );

      assert.equal(
        result.recommendation,
        null,
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
  "doctor reports DEGRADED when live health fails",
  async () => {
    const fx = fixture();

    try {
      writeReceipt(
        fx,
        {
          pid: process.pid,
        },
      );

      const result =
        await diagnoseControlServer({
          env: fx.env,

          async fetch_impl() {
            throw new Error(
              "connection refused"
            );
          },
        });

      assert.equal(
        result.status,
        "DEGRADED",
      );

      assert.equal(
        result.recommendation,
        "restart",
      );

      assert.match(
        result.health_error,
        /connection refused/,
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
