import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "devexec.mjs");
const GOOD_URL = "https://chatgpt.com/c/6a9ba452-8b64-83e8-a7f6-e5704521360b";

// NOTE: only refusal paths are exercised here. A valid continue would launch
// a live supervised run, so the success path is proven by live runs instead.
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-continue-"));
  const local = path.join(dir, "local");
  const stateDir = path.join(local, "ChatGPTMCPProbe", "dev-exec-state");
  fs.mkdirSync(path.join(local, "DevExec"), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(local, "DevExec", "targets.json"), JSON.stringify({
    schema_version: 1,
    default_target: "good",
    targets: {
      good: { transport: "chatgpt-web", chat_url: GOOD_URL, conversation_id: "6a9ba452-8b64-83e8-a7f6-e5704521360b" },
      broken: { transport: "chatgpt-web", chat_url: "https://chatgpt.com/c/not a url!!" },
    },
  }), "utf8");
  const put = (id, state) => fs.writeFileSync(path.join(stateDir, `${id}.json`), JSON.stringify({
    protocol: "dev-exec.state", schema_version: 1, run_id: id, parent_run_id: null,
    step: 0, pending: null, last_result: null,
    target: { target_id: "good", chat_url: GOOD_URL },
    ...state,
  }), "utf8");
  put("P-Terminal", { phase: "COMPLETE" });
  put("P-Active", { phase: "SUPERVISOR_ROUND_1_IN_FLIGHT" });
  put("P-Pend", { phase: "COMPLETE", step: 1, pending: { step: 1 } });
  return local;
}

function runCli(args, local) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: here,
    env: { ...process.env, LOCALAPPDATA: local },
    encoding: "utf8",
  });
  return { status: result.status, out: (result.stdout || "") + (result.stderr || "") };
}

test("continue refuses a missing parent without launching", () => {
  const out = runCli(["continue", "P-Nope", "--target", "good"], setup());
  assert.notEqual(out.status, 0);
  assert.ok(!out.out.includes("[devexec] continue parent="));
});

test("continue refuses a non-terminal parent without launching", () => {
  const out = runCli(["continue", "P-Active", "--target", "good"], setup());
  assert.notEqual(out.status, 0);
  assert.ok(out.out.includes("not terminal"));
  assert.ok(!out.out.includes("[devexec] continue parent="));
});

test("continue refuses an ambiguous pending parent without launching", () => {
  const out = runCli(["continue", "P-Pend", "--target", "good"], setup());
  assert.notEqual(out.status, 0);
  assert.ok(out.out.includes("ambiguous pending"));
  assert.ok(!out.out.includes("[devexec] continue parent="));
});

test("continue refuses an invalid alias beside a broken sibling", () => {
  const out = runCli(["continue", "P-Terminal", "--target", "broken"], setup());
  assert.notEqual(out.status, 0);
  assert.ok(out.out.includes("not usable"));
  assert.ok(!out.out.includes("[devexec] continue parent="));
});

