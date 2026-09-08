#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DevExecMissionController,
  MissionControllerError,
  wrapMissionControllerError,
} from "./devexec-mission-controller.mjs";

const MAX_INPUT_BYTES = 128 * 1024;
const MAX_WAIT_MS = 30_000;
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
const EXIT = Object.freeze({
  SUCCESS: 0,
  INVALID_INVOCATION_OR_SCHEMA: 2,
  REJECTED_OR_BLOCKED: 3,
  NEEDS_HUMAN: 4,
  TERMINAL_FAILED_OR_CANCELLED: 5,
  CONTROL_SERVICE_UNAVAILABLE: 6,
  WAIT_TIMEOUT_NON_TERMINAL: 7,
  AMBIGUOUS_OR_RECONCILIATION_REQUIRED: 8,
  PROTOCOL_VERSION_MISMATCH: 9,
});
const SHA256_REF = /^sha256:[a-f0-9]{64}$/;

function fail(code, message, { command = "mission", status = "REJECTED", retryable = false, exitCode = EXIT.INVALID_INVOCATION_OR_SCHEMA } = {}) {
  const error = new MissionControllerError(code, message, { status, retryable });
  error.command = command;
  error.exitCode = exitCode;
  throw error;
}

function ensureRegularFile(file, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink?.() || stat.isReparsePoint?.() || (Number.isInteger(stat.nlink) && stat.nlink > 1)) fail("UNSAFE_INPUT_PATH", `${label} must be a private regular file`);
  if (stat.size > MAX_INPUT_BYTES) fail("INPUT_TOO_LARGE", `${label} exceeds ${MAX_INPUT_BYTES} bytes`);
}

function readBoundedJson(source, label) {
  let bytes;
  if (source === "-") {
    bytes = fs.readFileSync(0);
    if (bytes.length > MAX_INPUT_BYTES) fail("INPUT_TOO_LARGE", `${label} exceeds ${MAX_INPUT_BYTES} bytes`);
  } else {
    if (typeof source !== "string" || !source) fail("INPUT_REQUIRED", `${label} path or - is required`);
    const file = path.resolve(source);
    ensureRegularFile(file, label);
    bytes = fs.readFileSync(file);
  }
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { fail("INVALID_JSON", `${label} is not valid JSON`); }
}

function parseOption(args, name, { required = false } = {}) {
  const index = args.indexOf(name);
  if (index < 0) {
    if (required) fail("MISSING_ARGUMENT", `${name} is required`);
    return null;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail("MISSING_ARGUMENT_VALUE", `${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function takeFlag(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function parseInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === null) return null;
  if (!/^\d+$/.test(value)) fail("INVALID_ARGUMENT", `${label} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) fail("INVALID_ARGUMENT", `${label} is outside the allowed range`);
  return parsed;
}

function loadAuthorityValidator(file) {
  if (!file) return undefined;
  const document = readBoundedJson(file, "authority file");
  const keys = Object.keys(document || {}).sort();
  if (keys.join(",") !== ["bindings", "protocol", "schema_version"].sort().join(",") || document.protocol !== "devexec.mission-authority" || document.schema_version !== 1 || !Array.isArray(document.bindings)) {
    fail("INVALID_AUTHORITY_FILE", "authority file schema is invalid", { status: "BLOCKED", exitCode: EXIT.REJECTED_OR_BLOCKED });
  }
  const authorityHash = `sha256:${crypto.createHash("sha256").update(JSON.stringify(document)).digest("hex")}`;
  const bindings = document.bindings.map((binding) => {
    const wanted = ["binding_id", "axes", "roles", "max_authority", "mission_ids"].sort().join(",");
    if (!binding || Object.keys(binding).sort().join(",") !== wanted || !SHA256_REF.test(binding.binding_id) || !Array.isArray(binding.axes) || !Array.isArray(binding.roles) || !Array.isArray(binding.mission_ids) || !new Set(["READ_ONLY", "BOUNDED_WRITE"]).has(binding.max_authority)) {
      fail("INVALID_AUTHORITY_FILE", "authority binding is invalid", { status: "BLOCKED", exitCode: EXIT.REJECTED_OR_BLOCKED });
    }
    return binding;
  });
  return ({ mission, actor, requested_authority: requestedAuthority }) => {
    const binding = bindings.find((item) => item.binding_id === actor.binding_id);
    const missionId = mission?.mission_id || "*";
    const rank = { READ_ONLY: 0, BOUNDED_WRITE: 1 };
    const allowed = !!binding
      && binding.axes.includes(actor.axis)
      && binding.roles.includes(actor.role)
      && (binding.mission_ids.includes("*") || binding.mission_ids.includes(missionId))
      && rank[requestedAuthority] <= rank[binding.max_authority];
    return { allowed, authority_ref: authorityHash };
  };
}

function stateDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.resolve(process.env.DEV_EXEC_MISSION_STATE_DIR || path.join(base, "ChatGPTMCPProbe", "dev-exec-missions"));
}

function output(value, jsonl = false) {
  if (jsonl) {
    for (const item of value) process.stdout.write(`${JSON.stringify(item)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  }
}

function errorExit(error, command) {
  const wrapped = wrapMissionControllerError(error);
  let exitCode = error?.exitCode || EXIT.REJECTED_OR_BLOCKED;
  if (wrapped.code.includes("UNSUPPORTED") || wrapped.code.includes("SCHEMA")) exitCode = EXIT.PROTOCOL_VERSION_MISMATCH;
  else if (wrapped.code.includes("INVALID") || wrapped.code.includes("REQUIRED") || wrapped.status === "REJECTED") exitCode = error?.exitCode || EXIT.INVALID_INVOCATION_OR_SCHEMA;
  else if (wrapped.code.includes("AMBIGUOUS") || wrapped.code.includes("CORRUPT") || wrapped.code.includes("STALE")) exitCode = EXIT.AMBIGUOUS_OR_RECONCILIATION_REQUIRED;
  output({
    protocol: "devexec.cli-error",
    schema_version: 1,
    command,
    status: wrapped.status,
    code: wrapped.code,
    message: wrapped.message.slice(0, 1024),
    retryable: wrapped.retryable,
    ambiguous_delivery: exitCode === EXIT.AMBIGUOUS_OR_RECONCILIATION_REQUIRED,
    correlation_id: null,
    details_ref: null,
  });
  return exitCode;
}

export async function runMissionCli(argv = process.argv.slice(2), env = process.env) {
  const args = [...argv];
  const subcommand = args.shift();
  const commandName = `mission ${subcommand || ""}`.trim();
  try {
    if (!new Set(["submit", "followup", "control", "reconcile", "inspect", "wait", "result", "events", "episodes"]).has(subcommand)) fail("INVALID_COMMAND", "mission requires submit, followup, control, reconcile, inspect, wait, result, events, or episodes", { command: commandName });
    const json = takeFlag(args, "--json");
    const jsonl = takeFlag(args, "--jsonl");
    if (json === jsonl) fail("MACHINE_MODE_REQUIRED", "pass exactly one of --json or --jsonl", { command: commandName });
    if (jsonl && subcommand !== "events") fail("JSONL_UNSUPPORTED", "--jsonl is only supported by mission events", { command: commandName });
    const controller = new DevExecMissionController({
      stateDir: env.DEV_EXEC_MISSION_STATE_DIR || stateDir(),
      validateAuthority: loadAuthorityValidator(env.DEV_EXEC_MISSION_AUTHORITY_FILE),
    });

    let value;
    if (subcommand === "submit") {
      const file = parseOption(args, "--request", { required: true });
      if (args.length) fail("UNKNOWN_ARGUMENT", `unknown argument ${args[0]}`, { command: commandName });
      value = controller.submit(readBoundedJson(file, "Mission request"));
    } else if (subcommand === "control" || subcommand === "followup") {
      const option = subcommand === "followup" ? "--event" : "--command";
      const file = parseOption(args, option, { required: true });
      if (args.length) fail("UNKNOWN_ARGUMENT", `unknown argument ${args[0]}`, { command: commandName });
      const document = readBoundedJson(file, "Mission command");
      if (subcommand === "followup" && document?.action !== "FOLLOWUP") fail("FOLLOWUP_ACTION_REQUIRED", "mission followup requires action FOLLOWUP", { command: commandName });
      value = controller.control(document);
    } else {
      const missionId = parseOption(args, "--mission", { required: true });
      if (subcommand === "reconcile") {
        if (args.length) fail("UNKNOWN_ARGUMENT", `unknown argument ${args[0]}`, { command: commandName });
        value = controller.reconcile(missionId);
      } else if (subcommand === "inspect") {
        if (args.length) fail("UNKNOWN_ARGUMENT", `unknown argument ${args[0]}`, { command: commandName });
        value = controller.inspect(missionId);
        if (!value) fail("MISSION_NOT_FOUND", "Mission not found", { command: commandName, status: "REJECTED" });
      } else if (subcommand === "result") {
        if (args.length) fail("UNKNOWN_ARGUMENT", `unknown argument ${args[0]}`, { command: commandName });
        value = controller.result(missionId);
        if (!value) fail("MISSION_NOT_FOUND", "Mission not found", { command: commandName, status: "REJECTED" });
      } else if (subcommand === "events") {
        const after = parseInteger(parseOption(args, "--after") || "0", "--after");
        const limit = parseInteger(parseOption(args, "--limit") || "256", "--limit", { min: 1, max: 1024 });
        if (args.length) fail("UNKNOWN_ARGUMENT", `unknown argument ${args[0]}`, { command: commandName });
        value = controller.listEvents(missionId, { after, limit });
      } else if (subcommand === "episodes") {
        const after = parseInteger(parseOption(args, "--after") || "0", "--after");
        const limit = parseInteger(parseOption(args, "--limit") || "256", "--limit", { min: 1, max: 1024 });
        if (args.length) fail("UNKNOWN_ARGUMENT", `unknown argument ${args[0]}`, { command: commandName });
        value = controller.listEpisodes(missionId, { after, limit });
        if (!value) fail("MISSION_NOT_FOUND", "Mission not found", { command: commandName, status: "REJECTED" });
      } else {
        const until = parseOption(args, "--until", { required: true });
        if (!new Set(["terminal", "revision", "episode-complete"]).has(until)) fail("INVALID_WAIT_CONDITION", "--until is invalid", { command: commandName });
        const timeoutMs = parseInteger(parseOption(args, "--timeout-ms", { required: true }), "--timeout-ms", { min: 0, max: MAX_WAIT_MS });
        const revision = parseInteger(parseOption(args, "--revision"), "--revision", { min: 1 });
        if (until === "revision" && revision === null) fail("MISSING_ARGUMENT", "--revision is required for revision wait", { command: commandName });
        if (until !== "revision" && revision !== null) fail("INVALID_ARGUMENT", "--revision is only valid for revision wait", { command: commandName });
        if (args.length) fail("UNKNOWN_ARGUMENT", `unknown argument ${args[0]}`, { command: commandName });
        const started = Date.now();
        let projection;
        let satisfied = false;
        do {
          projection = controller.inspect(missionId);
          if (!projection) fail("MISSION_NOT_FOUND", "Mission not found", { command: commandName, status: "REJECTED" });
          satisfied = until === "terminal" ? new Set(["COMPLETE", "CANCELLED", "FAILED", "BLOCKED", "NEEDS_HUMAN"]).has(projection.status)
            : until === "revision" ? projection.revision >= revision
              : projection.active_episode === null && projection.episodes.length > 0;
          if (!satisfied && Date.now() - started < timeoutMs) Atomics.wait(SLEEP_CELL, 0, 0, Math.min(25, timeoutMs - (Date.now() - started)));
        } while (!satisfied && Date.now() - started < timeoutMs);
        value = {
          protocol: "devexec.mission-wait",
          schema_version: 1,
          mission_id: missionId,
          condition: until,
          satisfied,
          state_revision: projection.revision,
          status: projection.status,
          continuation_cursor: projection.source_last_journal_seq,
          timed_out: !satisfied,
        };
        if (!satisfied) {
          output(value);
          return EXIT.WAIT_TIMEOUT_NON_TERMINAL;
        }
      }
    }
    output(subcommand === "events" && jsonl ? value.events : value, subcommand === "events" && jsonl);
    return EXIT.SUCCESS;
  } catch (error) {
    return errorExit(error, commandName);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(await runMissionCli());
}

export { EXIT as MISSION_CLI_EXIT_CODES };
