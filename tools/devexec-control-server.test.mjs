import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  closeDevExecControlServer,
  listenDevExecControlServer,
} from "./devexec-control-server.mjs";

function makeBase() {
  return fs.mkdtempSync(
    path.join(os.tmpdir(), "devexec-http-contract-"),
  );
}

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

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);

  return {
    status: response.status,
    body: await response.json(),
  };
}

test("listener binds only to 127.0.0.1", async () => {
  const base = makeBase();
  let listener = null;

  try {
    listener = await listenDevExecControlServer({
      base,
      env: {},
    });

    assert.equal(listener.host, "127.0.0.1");
  } finally {
    if (listener) {
      await closeDevExecControlServer(listener.server);
    }

    fs.rmSync(base, {recursive: true, force: true});
  }
});

test("non-loopback bind is rejected", async () => {
  const base = makeBase();

  try {
    await assert.rejects(
      () => listenDevExecControlServer({
        base,
        env: {},
        host: "0.0.0.0",
      }),
      /DEVEXEC_CONTROL_SERVER_LOOPBACK_ONLY/,
    );
  } finally {
    fs.rmSync(base, {recursive: true, force: true});
  }
});

test("health reports loopback-only transport", async () => {
  const base = makeBase();
  const listener = await listenDevExecControlServer({
    base,
    env: {},
  });

  try {
    const result = await requestJson(
      listener.url + "/health",
    );

    assert.equal(result.status, 200);
    assert.equal(result.body.status, "ok");
    assert.equal(
      result.body.bind_policy,
      "loopback-only",
    );
  } finally {
    await closeDevExecControlServer(listener.server);
    fs.rmSync(base, {recursive: true, force: true});
  }
});

test("run-state endpoint delegates to Control Service", async () => {
  const base = makeBase();
  writeState(base);

  const listener = await listenDevExecControlServer({
    base,
    env: {},
  });

  try {
    const result = await requestJson(
      listener.url + "/v1/runs/RUN-ROOT",
    );

    assert.equal(result.status, 200);
    assert.equal(result.body.state.run_id, "RUN-ROOT");
  } finally {
    await closeDevExecControlServer(listener.server);
    fs.rmSync(base, {recursive: true, force: true});
  }
});

test("capability endpoint reports safe durable parent", async () => {
  const base = makeBase();
  writeState(base);

  const listener = await listenDevExecControlServer({
    base,
    env: {},
  });

  try {
    const result = await requestJson(
      listener.url +
      "/v1/autonomous-start/capability?parent_run_id=RUN-ROOT",
    );

    assert.equal(result.status, 200);
    assert.equal(result.body.can_start, true);
    assert.equal(result.body.boundary.safe, true);
  } finally {
    await closeDevExecControlServer(listener.server);
    fs.rmSync(base, {recursive: true, force: true});
  }
});

test("POST delegates exactly once to Control Service", async () => {
  const base = makeBase();
  let calls = 0;

  const listener = await listenDevExecControlServer({
    base,
    env: {},
    control: {
      read_run_state() {
        throw new Error("unexpected read");
      },

      inspect_capability() {
        throw new Error("unexpected inspect");
      },

      async start_autonomous_run(input) {
        calls += 1;

        assert.equal(input.mission_id, "MISSION-X");

        return {
          protocol:
            "devexec.control.autonomous-start-receipt",
          schema_version: 1,
          status: "LAUNCHED",
          dispatched: true,
          replay_blocked: false,
          request_deduplicated: false,
        };
      },
    },
  });

  try {
    const result = await requestJson(
      listener.url + "/v1/autonomous-start",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          mission_id: "MISSION-X",
          parent_run_id: "RUN-ROOT",
          child_run_id: "RUN-CHILD",
          goal: "delegated goal",
          entry_path: "./tools/dev-exec-loop.mjs",
        }),
      },
    );

    assert.equal(result.status, 200);
    assert.equal(calls, 1);
    assert.equal(result.body.status, "LAUNCHED");
  } finally {
    await closeDevExecControlServer(listener.server);
    fs.rmSync(base, {recursive: true, force: true});
  }
});

test("POST requires application/json", async () => {
  const base = makeBase();

  const listener = await listenDevExecControlServer({
    base,
    env: {},
  });

  try {
    const result = await requestJson(
      listener.url + "/v1/autonomous-start",
      {
        method: "POST",
        body: "{}",
      },
    );

    assert.equal(result.status, 415);
    assert.equal(
      result.body.error,
      "HTTP_JSON_CONTENT_TYPE_REQUIRED",
    );
  } finally {
    await closeDevExecControlServer(listener.server);
    fs.rmSync(base, {recursive: true, force: true});
  }
});
