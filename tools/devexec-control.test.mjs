import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  openControlGui,
  statusControlServer,
} from "./devexec-control.mjs";

function fixture() {
  const root =
    fs.mkdtempSync(
      path.join(
        os.tmpdir(),
        "devexec-control-lifecycle-",
      ),
    );

  return {
    root,
    env: {
      LOCALAPPDATA: root,
    },
  };
}

test(
  "status reports stopped when no receipt exists",
  () => {
    const fx = fixture();

    try {
      const value =
        statusControlServer({
          env: fx.env,
        });

      assert.equal(
        value.running,
        false,
      );

      assert.equal(
        value.stale,
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

test(
  "open fails before server is running",
  () => {
    const fx = fixture();

    try {
      assert.throws(
        () =>
          openControlGui({
            env: fx.env,
            spawn_process() {
              throw new Error(
                "must not spawn"
              );
            },
          }),
        /DEVEXEC_CONTROL_GUI_SERVER_NOT_RUNNING/,
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
