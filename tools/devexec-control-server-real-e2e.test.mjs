import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  closeDevExecControlServer,
  listenDevExecControlServer,
} from "./devexec-control-server.mjs";

function writeState(base, {
  phase = "COMPLETE",
  pending = null,
} = {}) {
  const dir = path.join(
    base,
    "ChatGPTMCPProbe",
    "dev-exec-state",
  );

  fs.mkdirSync(dir, {recursive: true});

  fs.writeFileSync(
    path.join(dir, "RUN-ROOT.json"),
    JSON.stringify({
      run_id: "RUN-ROOT",
      phase,
      pending,
    }),
    "utf8",
  );
}

async function post(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

test("real localhost request starts one child and duplicate never replays", async () => {
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), "devexec-http-real-"),
  );

  const child = path.join(base, "child.mjs");
  const marker = path.join(base, "marker.txt");

  writeState(base);

  fs.writeFileSync(
    child,
    [
      'import fs from "node:fs";',
      `fs.appendFileSync(${JSON.stringify(marker)}, "once\\n", "utf8");`,
    ].join("\n") + "\n",
    "utf8",
  );

  const listener = await listenDevExecControlServer({
    base,
    env: {},
  });

  const request = {
    mission_id: "MISSION-HTTP",
    parent_run_id: "RUN-ROOT",
    child_run_id: "RUN-CHILD",
    goal: "localhost transport acceptance",
    entry_path: child,
    target_alias: "devexec-selfdev",
    constraints: [
      "preserve no-replay",
    ],
  };

  try {
    const first = await post(
      listener.url + "/v1/autonomous-start",
      request,
    );

    assert.equal(first.status, 200);
    assert.equal(first.body.status, "LAUNCHED");
    assert.equal(first.body.dispatched, true);

    const deadline = Date.now() + 10000;

    while (
      !fs.existsSync(marker) &&
      Date.now() < deadline
    ) {
      await new Promise(
        resolve => setTimeout(resolve, 20),
      );
    }

    assert.equal(
      fs.readFileSync(marker, "utf8"),
      "once\n",
    );

    const second = await post(
      listener.url + "/v1/autonomous-start",
      request,
    );

    assert.equal(second.status, 200);
    assert.equal(second.body.dispatched, false);
    assert.equal(second.body.replay_blocked, true);
    assert.equal(
      second.body.request_deduplicated,
      true,
    );

    await new Promise(
      resolve => setTimeout(resolve, 200),
    );

    assert.equal(
      fs.readFileSync(marker, "utf8"),
      "once\n",
    );
  } finally {
    await closeDevExecControlServer(listener.server);
    fs.rmSync(base, {recursive: true, force: true});
  }
});

test("real HTTP request blocks incomplete parent before child side effect", async () => {
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), "devexec-http-unsafe-"),
  );

  const child = path.join(base, "child.mjs");
  const marker = path.join(base, "marker.txt");

  writeState(base, {
    phase: "EXECUTING",
  });

  fs.writeFileSync(
    child,
    [
      'import fs from "node:fs";',
      `fs.appendFileSync(${JSON.stringify(marker)}, "unexpected\\n", "utf8");`,
    ].join("\n") + "\n",
    "utf8",
  );

  const listener = await listenDevExecControlServer({
    base,
    env: {},
  });

  try {
    const result = await post(
      listener.url + "/v1/autonomous-start",
      {
        mission_id: "MISSION-UNSAFE",
        parent_run_id: "RUN-ROOT",
        child_run_id: "RUN-CHILD",
        goal: "must not launch",
        entry_path: child,
      },
    );

    assert.equal(result.status, 409);

    assert.equal(
      result.body.error,
      "DEVEXEC_CONTROL_START_UNSAFE_BOUNDARY",
    );

    assert.equal(fs.existsSync(marker), false);
  } finally {
    await closeDevExecControlServer(listener.server);
    fs.rmSync(base, {recursive: true, force: true});
  }
});
