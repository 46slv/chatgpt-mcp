import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

import {
  closeDevExecControlServer,
  listenDevExecControlServer,
} from "./devexec-control-server.mjs";

const here =
  path.dirname(
    fileURLToPath(
      import.meta.url,
    ),
  );

const htmlPath =
  path.join(
    here,
    "devexec-control-ui.html",
  );

const jsPath =
  path.join(
    here,
    "devexec-control-ui.js",
  );

test(
  "GUI contains no Mission persistence or process-launch implementation",
  () => {
    const combined =
      fs.readFileSync(
        htmlPath,
        "utf8",
      ) +
      "\n" +
      fs.readFileSync(
        jsPath,
        "utf8",
      );

    for (
      const forbidden of [
        "requestMissionChildLaunch",
        "dispatchMissionChildLaunch",
        "startMissionRunAutonomously",
        "devexec-mission-control",
        "node:child_process",
        "spawn(",
        "spawnSync(",
      ]
    ) {
      assert.equal(
        combined.includes(
          forbidden
        ),
        false,
        `GUI must not contain ${forbidden}`,
      );
    }

    assert.match(
      combined,
      /\/health/,
    );

    assert.match(
      combined,
      /\/v1\/runs\//,
    );

    assert.match(
      combined,
      /\/v1\/autonomous-start\/capability/,
    );

    assert.match(
      combined,
      /\/v1\/autonomous-start/,
    );
  },
);

test(
  "GUI JavaScript source remains ASCII and strict UTF-8 safe",
  () => {
    const bytes =
      fs.readFileSync(
        jsPath,
      );

    const text =
      new TextDecoder(
        "utf-8",
        {
          fatal: true,
        },
      ).decode(bytes);

    for (
      const character of
      text
    ) {
      assert.ok(
        character.codePointAt(0) <=
          127,
        "GUI JavaScript must remain ASCII-only",
      );
    }
  },
);

test(
  "Control Server serves GUI from same loopback origin",
  async () => {
    const base =
      fs.mkdtempSync(
        path.join(
          os.tmpdir(),
          "devexec-ui-route-",
        ),
      );

    const listener =
      await listenDevExecControlServer({
        base,
        env: {},
      });

    try {
      assert.equal(
        listener.host,
        "127.0.0.1",
      );

      const htmlResponse =
        await fetch(
          listener.url +
          "/ui",
        );

      assert.equal(
        htmlResponse.status,
        200,
      );

      assert.match(
        htmlResponse.headers.get(
          "content-type",
        ) ?? "",
        /^text\/html/,
      );

      const html =
        await htmlResponse.text();

      assert.match(
        html,
        /Dev Exec Control/,
      );

      assert.match(
        html,
        /\/ui\/app\.js/,
      );

      const jsResponse =
        await fetch(
          listener.url +
          "/ui/app.js",
        );

      assert.equal(
        jsResponse.status,
        200,
      );

      assert.match(
        jsResponse.headers.get(
          "content-type",
        ) ?? "",
        /^text\/javascript/,
      );

      const js =
        await jsResponse.text();

      assert.match(
        js,
        /\/v1\/autonomous-start/,
      );

      assert.doesNotMatch(
        js,
        /startMissionRunAutonomously/,
      );
    } finally {
      await closeDevExecControlServer(
        listener.server,
      );

      fs.rmSync(
        base,
        {
          recursive: true,
          force: true,
        },
      );
    }
  },
);
