import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  inspectAutonomousStartCapability,
  readDevExecRunState,
  startAutonomousRun,
} from "./devexec-control-service.mjs";

function makeBase() {
  return fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      "devexec-control-service-",
    ),
  );
}

function writeState(base, {
  run_id = "RUN-ROOT",
  phase = "COMPLETE",
  pending = null,
  extra = {},
} = {}) {
  const dir = path.join(
    base,
    "ChatGPTMCPProbe",
    "dev-exec-state",
  );

  fs.mkdirSync(
    dir,
    {recursive: true},
  );

  fs.writeFileSync(
    path.join(
      dir,
      `${run_id}.json`,
    ),
    JSON.stringify({
      run_id,
      phase,
      pending,
      ...extra,
    }),
    "utf8",
  );
}

test(
  "control service reads exact durable run identity",
  () => {
    const base = makeBase();

    try {
      writeState(base);

      const state =
        readDevExecRunState({
          base,
          run_id: "RUN-ROOT",
          env: {},
        });

      assert.equal(
        state.run_id,
        "RUN-ROOT",
      );

      assert.equal(
        state.phase,
        "COMPLETE",
      );
    } finally {
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

test(
  "capability permits completed clean parent",
  () => {
    const base = makeBase();

    try {
      writeState(base);

      const capability =
        inspectAutonomousStartCapability({
          base,
          parent_run_id: "RUN-ROOT",
          env: {},
        });

      assert.equal(
        capability.can_start,
        true,
      );

      assert.equal(
        capability.boundary.safe,
        true,
      );
    } finally {
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

test(
  "capability rejects incomplete parent",
  () => {
    const base = makeBase();

    try {
      writeState(base, {
        phase: "EXECUTING",
      });

      const capability =
        inspectAutonomousStartCapability({
          base,
          parent_run_id: "RUN-ROOT",
          env: {},
        });

      assert.equal(
        capability.can_start,
        false,
      );

      assert.equal(
        capability.boundary.safe,
        false,
      );
    } finally {
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

test(
  "capability rejects pending or ambiguous parent",
  () => {
    const base = makeBase();

    try {
      writeState(base, {
        pending: {
          kind: "execution",
        },
      });

      const capability =
        inspectAutonomousStartCapability({
          base,
          parent_run_id: "RUN-ROOT",
          env: {},
        });

      assert.equal(
        capability.can_start,
        false,
      );

      assert.equal(
        capability.boundary.pending_action,
        true,
      );

      assert.equal(
        capability.boundary.ambiguous_action,
        true,
      );
    } finally {
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

test(
  "control start delegates once to typed Mission API",
  async () => {
    const base = makeBase();
    let calls = 0;
    let received = null;

    try {
      writeState(base);

      const receipt =
        await startAutonomousRun(
          {
            base,

            mission_id:
              "MISSION-CONTROL",

            parent_run_id:
              "RUN-ROOT",

            child_run_id:
              "RUN-CHILD",

            goal:
              "continue through control service",

            entry_path:
              "./tools/dev-exec-loop.mjs",

            target_alias:
              "devexec-selfdev",

            constraints: [
              "preserve safety",
            ],

            env: {},
          },
          {
            start:
              async input => {
                calls += 1;
                received = input;

                return {
                  status: "LAUNCHED",
                  dispatched: true,
                  replay_blocked: false,
                  request_deduplicated: false,
                  receipt: {
                    pid: 123,
                  },
                };
              },
          },
        );

      assert.equal(
        calls,
        1,
      );

      assert.equal(
        received.boundary.safe,
        true,
      );

      assert.equal(
        receipt.status,
        "LAUNCHED",
      );

      assert.equal(
        receipt.dispatched,
        true,
      );
    } finally {
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

test(
  "unsafe parent is blocked before typed API",
  async () => {
    const base = makeBase();
    let calls = 0;

    try {
      writeState(base, {
        phase: "EXECUTING",
      });

      await assert.rejects(
        () => startAutonomousRun(
          {
            base,

            mission_id:
              "MISSION-CONTROL",

            parent_run_id:
              "RUN-ROOT",

            child_run_id:
              "RUN-CHILD",

            goal:
              "must not launch",

            entry_path:
              "./tools/dev-exec-loop.mjs",

            env: {},
          },
          {
            start:
              async () => {
                calls += 1;
                return {};
              },
          },
        ),
        /DEVEXEC_CONTROL_START_UNSAFE_BOUNDARY/,
      );

      assert.equal(
        calls,
        0,
      );
    } finally {
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

test(
  "pending parent is blocked before typed API",
  async () => {
    const base = makeBase();
    let calls = 0;

    try {
      writeState(base, {
        pending: {
          kind: "execution",
        },
      });

      await assert.rejects(
        () => startAutonomousRun(
          {
            base,

            mission_id:
              "MISSION-CONTROL",

            parent_run_id:
              "RUN-ROOT",

            child_run_id:
              "RUN-CHILD",

            goal:
              "must not launch",

            entry_path:
              "./tools/dev-exec-loop.mjs",

            env: {},
          },
          {
            start:
              async () => {
                calls += 1;
                return {};
              },
          },
        ),
        /DEVEXEC_CONTROL_START_BLOCKED_IN_FLIGHT/,
      );

      assert.equal(
        calls,
        0,
      );
    } finally {
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
