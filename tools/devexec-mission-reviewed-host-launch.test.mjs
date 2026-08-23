import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {runReviewedHostAcceptance} from "./devexec-mission-reviewed-host-launch.mjs";

const HEAD = "3778734b6fc1a9e22b59adaa49803ac1daca49e2";

function withReviewedRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-reviewed-host-"));
  try {
    fs.mkdirSync(path.join(root, "tools"));
    fs.writeFileSync(path.join(root, "tools", "verify-devexec-mission-constraint-continuation.ps1"), "# test\n");
    fs.writeFileSync(path.join(root, "tools", "verify-devexec-mission-host-acceptance.ps1"), "# test\n");
    return fn(root);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
}

function successfulRunner(root, calls) {
  return (command, args, options) => {
    calls.push({command, args: [...args], options});
    if (command === "git") {
      const joined = args.join(" ");
      if (joined.includes("rev-parse --show-toplevel")) return {status: 0, stdout: `${root}\n`, stderr: ""};
      if (joined.includes("rev-parse HEAD")) return {status: 0, stdout: `${HEAD}\n`, stderr: ""};
      if (joined.includes("status --porcelain")) return {status: 0, stdout: "", stderr: ""};
      throw new Error(`unexpected git call ${joined}`);
    }
    const fileIndex = args.indexOf("-File");
    const script = fileIndex >= 0 ? args[fileIndex + 1] : "";
    if (script.endsWith("verify-devexec-mission-constraint-continuation.ps1")) {
      return {status: 0, stdout: "MISSION_RELIABILITY_CHECK=PASS\n", stderr: ""};
    }
    if (script.endsWith("verify-devexec-mission-host-acceptance.ps1")) {
      return {status: 0, stdout: "SUMMARY=x\nVERIFICATION=y\nMISSION_HOST_ACCEPTANCE=PASS\n", stderr: ""};
    }
    throw new Error(`unexpected command ${command} ${args.join(" ")}`);
  };
}

test("reviewed host launch isolates Git authority for ordinary verifier and unchanged host packet", () => withReviewedRoot((root) => {
  const calls = [];
  const report = runReviewedHostAcceptance({
    reviewedRoot: root,
    expectedHead: HEAD,
    powershellExecutable: "powershell.exe",
    baseEnv: {
      PATH: process.env.PATH ?? "",
      GIT_DIR: "C:/foreign/.git",
      GIT_WORK_TREE: "C:/foreign",
      GIT_CONFIG_SYSTEM: "C:/foreign/system.gitconfig",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "C:/hooks",
    },
    commandRunner: successfulRunner(root, calls),
  });
  assert.equal(report.status, "PASS");
  const powershellCalls = calls.filter((call) => call.command === "powershell.exe");
  assert.equal(powershellCalls.length, 2);
  for (const call of calls) {
    const env = call.options.env;
    assert.equal(Object.hasOwn(env, "GIT_DIR"), false);
    assert.equal(Object.hasOwn(env, "GIT_WORK_TREE"), false);
    assert.equal(Object.hasOwn(env, "GIT_CONFIG_SYSTEM"), false);
    assert.equal(Object.hasOwn(env, "GIT_CONFIG_KEY_0"), false);
    assert.equal(Object.hasOwn(env, "GIT_CONFIG_VALUE_0"), false);
    assert.equal(env.GIT_CONFIG_COUNT, "0");
    assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(env.GIT_CONFIG_GLOBAL, os.devNull);
    assert.equal(env.GIT_ATTR_NOSYSTEM, "1");
    assert.equal(env.GIT_NO_REPLACE_OBJECTS, "1");
  }
}));

test("missing ordinary reliability PASS marker prevents host packet launch", () => withReviewedRoot((root) => {
  const calls = [];
  const runner = successfulRunner(root, calls);
  assert.throws(() => runReviewedHostAcceptance({
    reviewedRoot: root,
    expectedHead: HEAD,
    powershellExecutable: "powershell.exe",
    commandRunner(command, args, options) {
      const fileIndex = args.indexOf("-File");
      const script = fileIndex >= 0 ? args[fileIndex + 1] : "";
      if (script.endsWith("verify-devexec-mission-constraint-continuation.ps1")) {
        calls.push({command, args: [...args], options});
        return {status: 0, stdout: "no marker\n", stderr: ""};
      }
      return runner(command, args, options);
    },
  }), /MISSION_REVIEWED_HOST_PASS_MARKER_MISSING/);
  assert.equal(calls.some((call) => call.args.some((arg) => String(arg).endsWith("verify-devexec-mission-host-acceptance.ps1"))), false);
}));

test("wrong reviewed HEAD fails before either PowerShell verifier is launched", () => withReviewedRoot((root) => {
  const calls = [];
  const runner = successfulRunner(root, calls);
  assert.throws(() => runReviewedHostAcceptance({
    reviewedRoot: root,
    expectedHead: HEAD,
    powershellExecutable: "powershell.exe",
    commandRunner(command, args, options) {
      if (command === "git" && args.join(" ").includes("rev-parse HEAD")) {
        calls.push({command, args: [...args], options});
        return {status: 0, stdout: `${"0".repeat(40)}\n`, stderr: ""};
      }
      return runner(command, args, options);
    },
  }), /MISSION_REVIEWED_HOST_HEAD_MISMATCH/);
  assert.equal(calls.some((call) => call.command === "powershell.exe"), false);
}));

test("host acceptance requires its exact PASS marker and forwards optional evidence root", () => withReviewedRoot((root) => {
  const calls = [];
  const evidenceRoot = path.join(root, "evidence");
  const runner = successfulRunner(root, calls);
  assert.throws(() => runReviewedHostAcceptance({
    reviewedRoot: root,
    expectedHead: HEAD,
    evidenceRoot,
    powershellExecutable: "powershell.exe",
    commandRunner(command, args, options) {
      const fileIndex = args.indexOf("-File");
      const script = fileIndex >= 0 ? args[fileIndex + 1] : "";
      if (script.endsWith("verify-devexec-mission-host-acceptance.ps1")) {
        calls.push({command, args: [...args], options});
        assert.ok(args.includes("-EvidenceRoot"));
        assert.ok(args.includes(path.resolve(evidenceRoot)));
        return {status: 0, stdout: "SUMMARY=x\n", stderr: ""};
      }
      return runner(command, args, options);
    },
  }), /MISSION_REVIEWED_HOST_PASS_MARKER_MISSING/);
}));
