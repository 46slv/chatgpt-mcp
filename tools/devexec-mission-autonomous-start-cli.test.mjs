import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAutonomousStartArgs,
  runAutonomousStartCli,
} from "./devexec-mission-autonomous-start-cli.mjs";

function outputCapture() {
  let text = "";

  return {
    stream: {
      write(value) {
        text += value;
      },
    },

    read() {
      return text;
    },
  };
}

test("parser reuses Mission identity and target from environment", () => {
  const parsed = parseAutonomousStartArgs(
    [
      "--child-run", "RUN-CHILD",
      "--goal", "continue work",
      "--entry", "./tools/dev-exec-loop.mjs",
      "--constraint", "preserve reliability",
    ],
    {
      env: {
        DEV_EXEC_MISSION_ID: "MISSION-CLI",
        DEV_EXEC_RUN_ID: "RUN-ROOT",
        DEV_EXEC_TARGET_ALIAS: "devexec-selfdev",
      },
    },
  );

  assert.equal(parsed.mission_id, "MISSION-CLI");
  assert.equal(parsed.parent_run_id, "RUN-ROOT");
  assert.equal(parsed.child_run_id, "RUN-CHILD");
  assert.equal(parsed.target_alias, "devexec-selfdev");
  assert.deepEqual(
    parsed.constraints,
    ["preserve reliability"],
  );
});

test("semantic duplicate args generate deterministic launch identity", () => {
  const args = [
    "--mission", "MISSION-CLI",
    "--parent-run", "RUN-ROOT",
    "--child-run", "RUN-CHILD",
    "--goal", "continue work",
    "--entry", "./tools/dev-exec-loop.mjs",
    "--target", "devexec-selfdev",
  ];

  const a = parseAutonomousStartArgs(args, {env: {}});
  const b = parseAutonomousStartArgs(args, {env: {}});

  assert.equal(a.launch_id, b.launch_id);
  assert.equal(a.idempotency_key, b.idempotency_key);
});

test("CLI invokes only typed start API and emits durable receipt shape", async () => {
  let calls = 0;
  let received = null;
  const capture = outputCapture();

  const receipt = await runAutonomousStartCli(
    [
      "--mission", "MISSION-CLI",
      "--parent-run", "RUN-ROOT",
      "--child-run", "RUN-CHILD",
      "--goal", "continue work",
      "--entry", "./tools/dev-exec-loop.mjs",
      "--target", "devexec-selfdev",
    ],
    {
      env: {},
      base: "C:/base",
      stdout: capture.stream,

      start: async input => {
        calls += 1;
        received = input;

        return {
          status: "LAUNCHED",
          dispatched: true,
          replay_blocked: false,
          request_deduplicated: false,
          receipt: {
            pid: 1234,
          },
        };
      },
    },
  );

  assert.equal(calls, 1);
  assert.equal(received.mission_id, "MISSION-CLI");
  assert.equal(received.parent_run_id, "RUN-ROOT");
  assert.equal(received.child_run_id, "RUN-CHILD");
  assert.equal(received.boundary.safe, true);
  assert.equal(receipt.status, "LAUNCHED");
  assert.deepEqual(receipt.launch_receipt, {pid: 1234});

  const emitted = JSON.parse(capture.read());
  assert.equal(emitted.protocol, "devexec.autonomous-start-cli");
  assert.equal(emitted.status, "LAUNCHED");
});

test("typed API unsafe-boundary rejection is surfaced without fallback launch", async () => {
  let calls = 0;

  await assert.rejects(
    runAutonomousStartCli(
      [
        "--mission", "MISSION-CLI",
        "--parent-run", "RUN-ROOT",
        "--child-run", "RUN-CHILD",
        "--goal", "continue work",
        "--entry", "./tools/dev-exec-loop.mjs",
      ],
      {
        env: {},
        base: "C:/base",
        stdout: {write() {}},

        start: async () => {
          calls += 1;
          throw new Error(
            "MISSION_AUTONOMOUS_START_UNSAFE_BOUNDARY"
          );
        },
      },
    ),
    /MISSION_AUTONOMOUS_START_UNSAFE_BOUNDARY/,
  );

  assert.equal(calls, 1);
});
