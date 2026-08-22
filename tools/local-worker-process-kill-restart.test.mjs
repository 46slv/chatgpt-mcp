import assert from "node:assert/strict";
import {once} from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";
import test from "node:test";

import {runIterativeLocalWorker} from "./local-worker-iterative-runner.mjs";
import {runLocalWorkerResume} from "./local-worker-resume-runtime.mjs";

function persist(file, actions) {
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify({actions}, null, 2) + "\n", "utf8");
  fs.renameSync(temp, file);
}

async function childMain(stateFile, dispatchMarker) {
  const actions = [];
  await runIterativeLocalWorker({
    mission: "process-kill replay fence",
    actions,
    maxRounds: 1,
    plan: async () => ({
      type: "REQUEST_ACTIONS",
      actions: [{action: "read_file", args: {path: "README.md"}}],
    }),
    onProgress: async ({pending}) => {
      if (pending) persist(stateFile, actions);
    },
    execute: async () => {
      fs.writeFileSync(dispatchMarker, "executor-dispatch-started\n", "utf8");
      await new Promise(() => {});
    },
  });
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

if (process.argv[2] === "--child") {
  const [, , , stateFile, dispatchMarker] = process.argv;
  if (!stateFile || !dispatchMarker) throw new Error("child fixture paths missing");
  await childMain(stateFile, dispatchMarker);
} else {
  test("real process termination after dispatch leaves pending fence and restart refuses replay", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-worker-process-kill-"));
    const stateFile = path.join(root, "state.json");
    const dispatchMarker = path.join(root, "dispatch-started.txt");
    const self = fileURLToPath(import.meta.url);

    const child = spawn(process.execPath, [self, "--child", stateFile, dispatchMarker], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    try {
      await waitFor(() => fs.existsSync(stateFile) && fs.existsSync(dispatchMarker));
      const beforeKill = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      assert.equal(beforeKill.actions.length, 1);
      assert.equal(beforeKill.actions[0].request_id, "R01-01-001");
      assert.equal(beforeKill.actions[0].pending, true);

      const exitPromise = once(child, "exit");
      assert.equal(child.kill(), true, "fixture child must be terminable");
      await exitPromise;

      const restartedActions = JSON.parse(fs.readFileSync(stateFile, "utf8")).actions;
      assert.equal(restartedActions.length, 1);
      assert.equal(restartedActions[0].request_id, "R01-01-001");
      assert.equal(restartedActions[0].pending, true);

      let replanned = false;
      let replayed = false;
      await assert.rejects(
        runLocalWorkerResume({
          mission: "resume after real process kill",
          actions: restartedActions,
          repair: {mode: "RETRY_PLANNER"},
          plan: async () => {
            replanned = true;
            return {type: "COMPLETE", summary: "must not run"};
          },
          execute: async () => {
            replayed = true;
            return {status: "PASS"};
          },
        }),
        /AMBIGUOUS_ACTION_IN_FLIGHT: R01-01-001/,
      );

      assert.equal(replanned, false);
      assert.equal(replayed, false);
      assert.equal(fs.readFileSync(dispatchMarker, "utf8"), "executor-dispatch-started\n");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      fs.rmSync(root, {recursive: true, force: true});
    }
  });
}
