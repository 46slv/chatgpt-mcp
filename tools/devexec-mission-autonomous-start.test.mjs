import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {openMissionControl} from "./devexec-mission-control.mjs";
import {readMissionLaunchState} from "./devexec-mission-launch.mjs";
import {
  startMissionRunAutonomously,
} from "./devexec-mission-autonomous-start.mjs";

function withBase(fn) {
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), "devexec-autonomous-start-")
  );

  return Promise.resolve(fn(base)).finally(() => {
    fs.rmSync(base, {recursive: true, force: true});
  });
}

function input(base, overrides = {}) {
  return {
    base,
    mission_id: "MISSION-AUTO",
    parent_run_id: "RUN-ROOT",
    child_run_id: "RUN-CHILD",
    goal: "continue autonomously",
    launch_id: "LAUNCH-AUTO-001",
    idempotency_key: "AUTO:001",
    target_alias: "devexec-selfdev",
    constraints: ["preserve reliability boundary"],
    boundary: {
      safe: true,
      pending_action: false,
      ambiguous_action: false,
    },
    entry_path: process.execPath,
    ...overrides,
  };
}

test("durable launch intent exists before autonomous dispatch side effect", () =>
  withBase(async base => {
    let dispatchCalls = 0;

    const result = await startMissionRunAutonomously(
      input(base),
      {
        dispatch_launch: async (control, launch, options) => {
          dispatchCalls += 1;

          const durable =
            readMissionLaunchState(control).launches[0];

          assert.equal(durable.status, "PENDING");
          assert.equal(durable.launch_id, "LAUNCH-AUTO-001");
          assert.equal(durable.parent_run_id, "RUN-ROOT");
          assert.equal(durable.child_run_id, "RUN-CHILD");
          assert.equal(durable.target_alias, "devexec-selfdev");
          assert.deepEqual(
            durable.constraints,
            ["preserve reliability boundary"],
          );

          assert.equal(
            options.launch_attempt_id,
            "LAUNCH-AUTO-001:autonomous-attempt",
          );

          assert.equal(
            options.launcher_request_id,
            "LAUNCH-AUTO-001:autonomous-request",
          );

          return {
            launch: {
              ...launch,
              status: "LAUNCHED",
              receipt: {pid: 12345},
            },
            receipt: {pid: 12345},
          };
        },
      },
    );

    assert.equal(dispatchCalls, 1);
    assert.equal(result.status, "LAUNCHED");
    assert.equal(result.dispatched, true);
    assert.deepEqual(result.receipt, {pid: 12345});
  }));

test("unsafe boundary is rejected before durable intent or dispatch", () =>
  withBase(async base => {
    let dispatchCalls = 0;

    await assert.rejects(
      startMissionRunAutonomously(
        input(base, {
          boundary: {safe: false},
        }),
        {
          dispatch_launch: async () => {
            dispatchCalls += 1;
          },
        },
      ),
      /MISSION_AUTONOMOUS_START_UNSAFE_BOUNDARY/,
    );

    assert.equal(dispatchCalls, 0);

    const control = openMissionControl({
      base,
      mission_id: "MISSION-AUTO",
      run_id: "RUN-ROOT",
    });

    assert.equal(
      readMissionLaunchState(control).launches.length,
      0,
    );
  }));

test("pending or ambiguous action boundary is rejected before dispatch", () =>
  withBase(async base => {
    for (const boundary of [
      {safe: true, pending_action: true},
      {safe: true, ambiguous_action: true},
    ]) {
      let dispatchCalls = 0;

      await assert.rejects(
        startMissionRunAutonomously(
          input(base, {
            mission_id:
              boundary.pending_action
                ? "MISSION-PENDING"
                : "MISSION-AMBIG",
            boundary,
          }),
          {
            dispatch_launch: async () => {
              dispatchCalls += 1;
            },
          },
        ),
        /MISSION_AUTONOMOUS_START_BLOCKED_BY_IN_FLIGHT_ACTION/,
      );

      assert.equal(dispatchCalls, 0);
    }
  }));

test("durable LAUNCHING duplicate never replays child spawn", async () => {
  let dispatchCalls = 0;

  const launch = {
    launch_id: "LAUNCH-AUTO-001",
    status: "LAUNCHING",
    launch_attempt_id: "LAUNCH-AUTO-001:autonomous-attempt",
    launcher_request_id: "LAUNCH-AUTO-001:autonomous-request",
  };

  const result = await startMissionRunAutonomously(
    input("C:/durable-base"),
    {
      open_control: () => ({
        state: {
          current_run_id: "RUN-ROOT",
        },
      }),

      request_launch: () => ({
        launch,
        deduplicated: true,
      }),

      dispatch_launch: async () => {
        dispatchCalls += 1;
        throw new Error("must not dispatch");
      },
    },
  );

  assert.equal(dispatchCalls, 0);
  assert.equal(result.status, "LAUNCHING");
  assert.equal(result.dispatched, false);
  assert.equal(result.replay_blocked, true);
  assert.equal(result.request_deduplicated, true);
});

test("already launched duplicate returns durable receipt without replay", async () => {
  let dispatchCalls = 0;

  const launch = {
    launch_id: "LAUNCH-AUTO-001",
    status: "LAUNCHED",
    receipt: {
      pid: 9876,
      launcher_request_id:
        "LAUNCH-AUTO-001:autonomous-request",
    },
  };

  const result = await startMissionRunAutonomously(
    input("C:/durable-base"),
    {
      open_control: () => ({
        state: {
          current_run_id: "RUN-ROOT",
        },
      }),

      request_launch: () => ({
        launch,
        deduplicated: true,
      }),

      dispatch_launch: async () => {
        dispatchCalls += 1;
      },
    },
  );

  assert.equal(dispatchCalls, 0);
  assert.equal(result.status, "LAUNCHED");
  assert.equal(result.dispatched, false);
  assert.equal(result.replay_blocked, true);
});

test("ambiguous launch fails closed and is never replayed", async () => {
  let dispatchCalls = 0;

  await assert.rejects(
    startMissionRunAutonomously(
      input("C:/durable-base"),
      {
        open_control: () => ({
          state: {
            current_run_id: "RUN-ROOT",
          },
        }),

        request_launch: () => ({
          launch: {
            launch_id: "LAUNCH-AUTO-001",
            status: "AMBIGUOUS",
          },
          deduplicated: true,
        }),

        dispatch_launch: async () => {
          dispatchCalls += 1;
        },
      },
    ),
    /MISSION_AUTONOMOUS_START_AMBIGUOUS_NO_REPLAY/,
  );

  assert.equal(dispatchCalls, 0);
});

test("changed request with same idempotency key fails through canonical Mission contract", () =>
  withBase(async base => {
    const first = input(base);

    await startMissionRunAutonomously(
      first,
      {
        dispatch_launch: async (_control, launch) => ({
          launch: {
            ...launch,
            status: "LAUNCHED",
          },
        }),
      },
    );

    await assert.rejects(
      startMissionRunAutonomously(
        input(base, {
          goal: "different semantic request",
        }),
        {
          dispatch_launch: async () => {
            throw new Error("must not dispatch conflicting request");
          },
        },
      ),
      /LAUNCH_IDEMPOTENCY_KEY_CONFLICT/,
    );
  }));
