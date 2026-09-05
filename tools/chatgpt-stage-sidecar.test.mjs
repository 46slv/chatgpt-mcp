import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { typeText } from "../dist/browser.js";
import { appendStageEvent, defaultStageSidecarPath, stageSidecarPath } from "../dist/utils/stage-sidecar.js";

function tempFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stage-sidecar-")), name);
}

test("stage sidecar appends parseable JSONL events", () => {
  const file = tempFile("events.jsonl");
  appendStageEvent({ scope: "reply", stage: "submit-begin", conversation_id: "chat-x" }, file);
  appendStageEvent({ scope: "reply", stage: "failed", error: "boom" }, file);
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).stage, "submit-begin");
  assert.equal(JSON.parse(lines[1]).error, "boom");
  assert.ok(typeof JSON.parse(lines[0]).ts === "string");
});

test("stage sidecar never throws on an unwritable path", () => {
  assert.doesNotThrow(() => appendStageEvent({ scope: "reply", stage: "x" }, path.join("Z:", "no-such-dir-9f3", "s.jsonl")));
});

test("default sidecar path lives in the OS temp directory", () => {
  assert.equal(path.dirname(defaultStageSidecarPath()), os.tmpdir());
  assert.ok(defaultStageSidecarPath().endsWith(".jsonl"));
});

test("typeText emits composer markers without logging prompt text", async () => {
  const file = tempFile("composer.jsonl");
  const previous = process.env.CHATGPT_MCP_STAGE_SIDECAR;
  process.env.CHATGPT_MCP_STAGE_SIDECAR = file;
  try {
    const element = { click: async () => {}, focus: async () => {}, fill: async () => {}, type: async () => {} };
    assert.equal(await typeText(["#prompt-textarea"], "secret-prompt", async () => element), true);
  } finally {
    if (previous === undefined) delete process.env.CHATGPT_MCP_STAGE_SIDECAR;
    else process.env.CHATGPT_MCP_STAGE_SIDECAR = previous;
  }
  const events = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((entry) => entry.stage), ["composer-located", "composer-focused", "composer-cleared", "composer-typed"]);
  assert.ok(events.every((entry) => entry.scope === "composer"));
  assert.ok(!fs.readFileSync(file, "utf8").includes("secret-prompt"));
  assert.equal(stageSidecarPath(), defaultStageSidecarPath());
});
