import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DevExecMissionController, MISSION_COMMAND_PROTOCOL, MISSION_REQUEST_PROTOCOL } from "./devexec-mission-controller.mjs";
import { MISSION_CLI_EXIT_CODES } from "./devexec-mission-cli.mjs";

const BINDING = `sha256:${"e".repeat(64)}`;
const CLI = path.resolve("tools/devexec-mission-cli.mjs");
const ROOT_CLI = path.resolve("tools/devexec.mjs");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "devexec-f03-cli-"));
}

function writeJson(root, name, value) {
  const file = path.join(root, name);
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
  return file;
}

function runCli(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function fixture(root) {
  const authority = writeJson(root, "authority.json", {
    protocol: "devexec.mission-authority",
    schema_version: 1,
    bindings: [{
      binding_id: BINDING,
      axes: ["DETERMINISTIC", "MISSION_GOVERNANCE"],
      roles: ["OPERATOR_INGRESS", "MISSION_GOVERNOR"],
      max_authority: "BOUNDED_WRITE",
      mission_ids: ["*"],
    }],
  });
  return {
    env: { DEV_EXEC_MISSION_STATE_DIR: path.join(root, "state"), DEV_EXEC_MISSION_AUTHORITY_FILE: authority },
    request: {
      protocol: MISSION_REQUEST_PROTOCOL,
      schema_version: 1,
      event_id: "evt-cli-create",
      request_id: "req-cli-create",
      idempotency_key: "idem-cli-create",
      occurred_at: "2026-09-08T01:00:00.000Z",
      source: { type: "operator", adapter: "mission-cli-test", binding_id: BINDING },
      actor: { binding_id: BINDING, axis: "DETERMINISTIC", role: "OPERATOR_INGRESS" },
      intent: "TASK",
      requested_authority: "BOUNDED_WRITE",
      goal: { goal_id: "goal-cli", summary: "CLI fixture", acceptance_refs: ["test:cli"], protected_constraints: [] },
      correlation_id: "corr-cli-create",
    },
  };
}

test("Mission CLI root route provides strict JSON submit/control/inspect/result/events/wait", { timeout: 20000 }, async () => {
  const root = tmp();
  const { env, request } = fixture(root);
  const requestFile = writeJson(root, "request.json", request);
  const submitted = await runCli(ROOT_CLI, ["mission", "submit", "--request", requestFile, "--json"], env);
  assert.equal(submitted.code, 0, submitted.stderr || submitted.stdout);
  const receipt = JSON.parse(submitted.stdout);
  assert.match(receipt.mission_id, /^mission-[a-f0-9]{32}$/);
  assert.equal(receipt.state_revision, 1);

  let inspected = await runCli(CLI, ["inspect", "--mission", receipt.mission_id, "--json"], env);
  assert.equal(inspected.code, 0);
  let projection = JSON.parse(inspected.stdout);
  assert.equal(projection.status, "CREATED");

  const start = {
    protocol: MISSION_COMMAND_PROTOCOL,
    schema_version: 1,
    event_id: "evt-cli-start",
    request_id: "req-cli-start",
    idempotency_key: "idem-cli-start",
    occurred_at: "2026-09-08T01:01:00.000Z",
    source: { type: "operator", adapter: "mission-cli-test", binding_id: BINDING },
    actor: { binding_id: BINDING, axis: "MISSION_GOVERNANCE", role: "MISSION_GOVERNOR" },
    mission_id: receipt.mission_id,
    expected_revision: projection.revision,
    action: "START",
    data: { reason: "CLI start" },
    correlation_id: "corr-cli-start",
  };
  const commandFile = writeJson(root, "start.json", start);
  const controlled = await runCli(CLI, ["control", "--command", commandFile, "--json"], env);
  assert.equal(controlled.code, 0, controlled.stdout);
  assert.equal(JSON.parse(controlled.stdout).mission_status, "RUNNING");

  const result = await runCli(CLI, ["result", "--mission", receipt.mission_id, "--json"], env);
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).status, "NOT_TERMINAL");

  const events = await runCli(CLI, ["events", "--mission", receipt.mission_id, "--after", "0", "--limit", "10", "--jsonl"], env);
  assert.equal(events.code, 0);
  const lines = events.stdout.trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(lines.map((item) => item.event_id), ["evt-cli-create", "evt-cli-start"]);
  assert.equal(lines.every((item) => Number.isInteger(item.cursor)), true);

  const wait = await runCli(CLI, ["wait", "--mission", receipt.mission_id, "--until", "terminal", "--timeout-ms", "0", "--json"], env);
  assert.equal(wait.code, MISSION_CLI_EXIT_CODES.WAIT_TIMEOUT_NON_TERMINAL);
  assert.equal(JSON.parse(wait.stdout).timed_out, true);

  const beforeInvalid = JSON.parse((await runCli(CLI, ["inspect", "--mission", receipt.mission_id, "--json"], env)).stdout).revision;
  const invalid = await runCli(CLI, ["control", "--command", commandFile, "--unknown", "x", "--json"], env);
  assert.equal(invalid.code, MISSION_CLI_EXIT_CODES.INVALID_INVOCATION_OR_SCHEMA);
  assert.equal(JSON.parse(invalid.stdout).code, "UNKNOWN_ARGUMENT");
  const afterInvalid = JSON.parse((await runCli(CLI, ["inspect", "--mission", receipt.mission_id, "--json"], env)).stdout).revision;
  assert.equal(afterInvalid, beforeInvalid);

  const crashController = new DevExecMissionController({ stateDir: env.DEV_EXEC_MISSION_STATE_DIR, validateAuthority: () => ({ allowed: true, authority_ref: "test:cli" }) });
  const cancel = { ...start, event_id: "evt-cli-cancel", request_id: "req-cli-cancel", idempotency_key: "idem-cli-cancel", correlation_id: "corr-cli-cancel", expected_revision: afterInvalid, action: "CANCEL", data: { reason: "test recovery", evidence_refs: [] } };
  crashController.coreComplete = () => { throw new Error("injected CLI terminal crash"); };
  assert.throws(() => crashController.control(cancel), /injected CLI terminal crash/);
  const reconciled = await runCli(ROOT_CLI, ["mission", "reconcile", "--mission", receipt.mission_id, "--json"], env);
  assert.equal(reconciled.code, 0, reconciled.stdout);
  assert.equal(JSON.parse(reconciled.stdout).result_status, "CANCELLED");
  const terminal = await runCli(CLI, ["result", "--mission", receipt.mission_id, "--json"], env);
  assert.equal(JSON.parse(terminal.stdout).status, "CANCELLED");
});

test("Mission CLI schema and authority failures remain one parseable error document", async () => {
  const root = tmp();
  const { env } = fixture(root);
  const malformed = path.join(root, "malformed.json");
  fs.writeFileSync(malformed, "{bad\n", "utf8");
  const bad = await runCli(CLI, ["submit", "--request", malformed, "--json"], env);
  assert.equal(bad.code, MISSION_CLI_EXIT_CODES.INVALID_INVOCATION_OR_SCHEMA);
  const error = JSON.parse(bad.stdout);
  assert.equal(error.protocol, "devexec.cli-error");
  assert.equal(error.code, "INVALID_JSON");
  assert.equal(bad.stdout.trim().split(/\r?\n/).length, 1);

  const noAuthorityEnv = { DEV_EXEC_MISSION_STATE_DIR: path.join(root, "no-authority") };
  const requestFile = writeJson(root, "request.json", fixture(root).request);
  const denied = await runCli(CLI, ["submit", "--request", requestFile, "--json"], noAuthorityEnv);
  assert.equal(denied.code, MISSION_CLI_EXIT_CODES.INVALID_INVOCATION_OR_SCHEMA);
  assert.equal(JSON.parse(denied.stdout).code, "AUTHORITY_VALIDATOR_REQUIRED");
});
