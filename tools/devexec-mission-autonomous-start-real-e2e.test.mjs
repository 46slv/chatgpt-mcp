import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  openMissionControl,
} from "./devexec-mission-control.mjs";
import {
  readMissionLaunchState,
} from "./devexec-mission-launch.mjs";
import {
  startMissionRunAutonomously,
} from "./devexec-mission-autonomous-start.mjs";

function makeBase() {
  return fs.mkdtempSync(
    path.join(os.tmpdir(), "devexec-autonomous-real-e2e-"),
  );
}

async function waitForRecord(file, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      const lines = fs
        .readFileSync(file, "utf8")
        .split(/\r?\n/)
        .filter(Boolean);

      if (lines.length > 0) {
        return lines.map(line => JSON.parse(line));
      }
    }

    await new Promise(resolve => setTimeout(resolve, 20));
  }

  throw new Error("AUTONOMOUS_REAL_CHILD_MARKER_TIMEOUT");
}

test(
  "typed autonomous start performs one real child spawn with durable receipt and never replays duplicate request",
  async () => {
    const base = makeBase();
    const marker = path.join(base, "child-records.jsonl");
    const child = path.join(base, "autonomous-child.mjs");

    try {
      fs.writeFileSync(
        child,
        [
          'import fs from "node:fs";',
          "const record = {",
          "  mission_id: process.env.DEV_EXEC_MISSION_ID ?? null,",
          "  parent_run_id: process.env.DEV_EXEC_PARENT_RUN_ID ?? null,",
          "  run_id: process.env.DEV_EXEC_RUN_ID ?? null,",
          "  target_alias: process.env.DEV_EXEC_TARGET_ALIAS ?? null,",
          "  constraints_json: process.env.DEV_EXEC_MISSION_CONSTRAINTS_JSON ?? null,",
          "  goal: process.argv[2] ?? null,",
          "};",
          `fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify(record) + "\\n", "utf8");`,
        ].join("\n") + "\n",
        "utf8",
      );

      const request = {
        base,
        mission_id: "MISSION-AUTO-REAL",
        parent_run_id: "RUN-ROOT",
        child_run_id: "RUN-CHILD",
        goal: "start the next Dev Exec run autonomously",
        launch_id: "LAUNCH-AUTO-REAL-001",
        idempotency_key: "AUTO-REAL:001",
        target_alias: "devexec-selfdev",
        constraints: [
          "preserve mission reliability",
          "do not advance to GUI yet",
        ],
        boundary: {
          safe: true,
          pending_action: false,
          ambiguous_action: false,
        },
        entry_path: child,
      };

      const first = await startMissionRunAutonomously(request);

      assert.equal(first.dispatched, true);
      assert.equal(first.replay_blocked, false);
      assert.equal(first.status, "LAUNCHED");
      assert.ok(first.receipt);
      assert.ok(Number.isInteger(first.receipt.pid));
      assert.ok(first.receipt.pid > 0);

      const records = await waitForRecord(marker);

      assert.equal(records.length, 1);
      assert.equal(records[0].mission_id, "MISSION-AUTO-REAL");
      assert.equal(records[0].parent_run_id, "RUN-ROOT");
      assert.equal(records[0].run_id, "RUN-CHILD");
      assert.equal(records[0].target_alias, "devexec-selfdev");
      assert.equal(
        records[0].goal,
        "start the next Dev Exec run autonomously",
      );

      assert.deepEqual(
        JSON.parse(records[0].constraints_json),
        [
          "preserve mission reliability",
          "do not advance to GUI yet",
        ],
      );

      const control = openMissionControl({
        base,
        mission_id: "MISSION-AUTO-REAL",
        run_id: "RUN-ROOT",
      });

      const durableAfterFirst =
        readMissionLaunchState(control).launches[0];

      assert.equal(durableAfterFirst.status, "LAUNCHED");
      assert.equal(
        durableAfterFirst.launch_id,
        "LAUNCH-AUTO-REAL-001",
      );
      assert.equal(
        durableAfterFirst.child_run_id,
        "RUN-CHILD",
      );
      assert.ok(durableAfterFirst.receipt);
      assert.equal(
        durableAfterFirst.receipt.pid,
        first.receipt.pid,
      );

      const second = await startMissionRunAutonomously(request);

      assert.equal(second.dispatched, false);
      assert.equal(second.replay_blocked, true);
      assert.equal(second.request_deduplicated, true);
      assert.equal(second.status, "LAUNCHED");

      await new Promise(resolve => setTimeout(resolve, 200));

      const afterDuplicate = fs
        .readFileSync(marker, "utf8")
        .split(/\r?\n/)
        .filter(Boolean);

      assert.equal(
        afterDuplicate.length,
        1,
        "duplicate autonomous start must not spawn another child",
      );

      const durableAfterDuplicate =
        readMissionLaunchState(control).launches[0];

      assert.equal(durableAfterDuplicate.status, "LAUNCHED");
      assert.equal(
        durableAfterDuplicate.receipt.pid,
        first.receipt.pid,
      );
    } finally {
      fs.rmSync(base, {recursive: true, force: true});
    }
  },
);
