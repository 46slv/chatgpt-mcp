import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  deriveAutonomousStartBoundary,
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

function writeParentState(base, {
  run_id = "RUN-ROOT",
  phase = "COMPLETE",
  pending = null,
  extra = {},
} = {}) {
  const stateDir = path.join(
    base,
    "ChatGPTMCPProbe",
    "dev-exec-state",
  );

  fs.mkdirSync(stateDir, {recursive: true});

  fs.writeFileSync(
    path.join(stateDir, run_id + ".json"),
    JSON.stringify({
      run_id,
      phase,
      pending,
      ...extra,
    }),
    "utf8",
  );
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

test("durable COMPLETE parent with no pending action derives safe boundary", () => {
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), "devexec-cli-safe-"),
  );

  try {
    writeParentState(base);

    assert.deepEqual(
      deriveAutonomousStartBoundary({
        base,
        parent_run_id: "RUN-ROOT",
        env: {},
      }),
      {
        safe: true,
        pending_action: false,
        ambiguous_action: false,
        current_goal_complete: true,
      },
    );
  } finally {
    fs.rmSync(base, {recursive: true, force: true});
  }
});

test("non-COMPLETE parent is derived unsafe", () => {
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), "devexec-cli-running-"),
  );

  try {
    writeParentState(base, {
      phase: "EXECUTING",
    });

    const boundary = deriveAutonomousStartBoundary({
      base,
      parent_run_id: "RUN-ROOT",
      env: {},
    });

    assert.equal(boundary.safe, false);
    assert.equal(
      boundary.current_goal_complete,
      false,
    );
  } finally {
    fs.rmSync(base, {recursive: true, force: true});
  }
});

test("pending parent action is propagated and blocks autonomous launch", () => {
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), "devexec-cli-pending-"),
  );

  try {
    writeParentState(base, {
      pending: {
        kind: "execution",
      },
    });

    const boundary = deriveAutonomousStartBoundary({
      base,
      parent_run_id: "RUN-ROOT",
      env: {},
    });

    assert.equal(boundary.safe, true);
    assert.equal(boundary.pending_action, true);
    assert.equal(boundary.ambiguous_action, true);
  } finally {
    fs.rmSync(base, {recursive: true, force: true});
  }
});

test("explicit ambiguous parent flag is propagated", () => {
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), "devexec-cli-ambiguous-"),
  );

  try {
    writeParentState(base, {
      extra: {
        ambiguous_action: true,
      },
    });

    const boundary = deriveAutonomousStartBoundary({
      base,
      parent_run_id: "RUN-ROOT",
      env: {},
    });

    assert.equal(boundary.safe, true);
    assert.equal(boundary.pending_action, false);
    assert.equal(boundary.ambiguous_action, true);
  } finally {
    fs.rmSync(base, {recursive: true, force: true});
  }
});

test("missing parent state fails closed before typed start API", async () => {
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), "devexec-cli-missing-"),
  );

  let calls = 0;

  try {
    await assert.rejects(
      () => runAutonomousStartCli(
        [
          "--mission", "MISSION-CLI",
          "--parent-run", "RUN-ROOT",
          "--child-run", "RUN-CHILD",
          "--goal", "continue work",
          "--entry", "./tools/dev-exec-loop.mjs",
        ],
        {
          env: {},
          base,
          stdout: {write() {}},
          start: async () => {
            calls += 1;
            return {};
          },
        },
      ),
      /MISSION_AUTONOMOUS_START_BOUNDARY_STATE_MISSING/,
    );

    assert.equal(calls, 0);
  } finally {
    fs.rmSync(base, {recursive: true, force: true});
  }
});

test("CLI invokes typed start once with the derived durable boundary", async () => {
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

      resolve_boundary() {
        return {
          safe: true,
          pending_action: false,
          ambiguous_action: false,
          current_goal_complete: true,
        };
      },

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
  assert.equal(
    received.boundary.current_goal_complete,
    true,
  );
  assert.equal(receipt.status, "LAUNCHED");
  assert.deepEqual(receipt.launch_receipt, {pid: 1234});

  const emitted = JSON.parse(capture.read());

  assert.equal(
    emitted.protocol,
    "devexec.autonomous-start-cli",
  );
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

        resolve_boundary() {
          return {
            safe: false,
            pending_action: false,
            ambiguous_action: false,
            current_goal_complete: false,
          };
        },

        start: async input => {
          calls += 1;

          assert.equal(input.boundary.safe, false);

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
