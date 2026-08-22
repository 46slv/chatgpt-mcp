import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {runIterativeLocalWorker} from "./local-worker-iterative-runner.mjs";
import {runLocalWorkerResume} from "./local-worker-resume-runtime.mjs";

function persist(file, actions) {
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify({actions}, null, 2) + "\n", "utf8");
  fs.renameSync(temp, file);
}

test("persisted pending fence survives restart after an executor-side effect and blocks replay", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-worker-restart-fence-"));
  const stateFile = path.join(root, "state.json");
  const sideEffectFile = path.join(root, "executor-side-effect.txt");
  const actions = [];
  let firstExecuteCount = 0;

  await assert.rejects(
    runIterativeLocalWorker({
      mission: "inspect",
      actions,
      maxRounds: 1,
      plan: async () => ({type: "REQUEST_ACTIONS", actions: [{action: "read_file", args: {path: "README.md"}}]}),
      onProgress: async ({pending}) => {
        if (pending) persist(stateFile, actions);
      },
      execute: async () => {
        firstExecuteCount += 1;
        fs.writeFileSync(sideEffectFile, "executor may already have succeeded\n", "utf8");
        throw new Error("simulated process loss after executor side effect");
      },
    }),
    /simulated process loss after executor side effect/,
  );

  assert.equal(firstExecuteCount, 1);
  assert.equal(fs.existsSync(sideEffectFile), true);
  const restartedActions = JSON.parse(fs.readFileSync(stateFile, "utf8")).actions;
  assert.equal(restartedActions.length, 1);
  assert.equal(restartedActions[0].request_id, "R01-01-001");
  assert.equal(restartedActions[0].pending, true);

  let replanned = false;
  let replayed = false;
  await assert.rejects(
    runLocalWorkerResume({
      mission: "resume",
      actions: restartedActions,
      repair: {mode: "RETRY_PLANNER"},
      plan: async () => {
        replanned = true;
        return {type: "COMPLETE", summary: "wrong"};
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
  assert.equal(fs.readFileSync(sideEffectFile, "utf8"), "executor may already have succeeded\n");
});
