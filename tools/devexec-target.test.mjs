import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "devexec-target.mjs");
const GOOD_URL = "https://chatgpt.com/c/6a9ba452-8b64-83e8-a7f6-e5704521360b";

function setupRegistry(value) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-target-cli-"));
  const local = path.join(dir, "local");
  fs.mkdirSync(path.join(local, "DevExec"), { recursive: true });
  const file = path.join(local, "DevExec", "targets.json");
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
  return { dir, local, file };
}

function runCli(args, local, cwd) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: cwd || here,
    env: { ...process.env, LOCALAPPDATA: local },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function mixedRegistry() {
  return {
    schema_version: 1,
    default_target: "good",
    targets: {
      good: { transport: "chatgpt-web", title: "Good", chat_url: GOOD_URL, conversation_id: "6a9ba452-8b64-83e8-a7f6-e5704521360b" },
      broken: { transport: "chatgpt-web", title: "Broken", chat_url: "https://chatgpt.com/g/g-p-slug/c/ZZZ/project-extra/wrong" },
    },
  };
}

test("list shows valid entries with per-entry errors and exit 0", () => {
  const { local } = setupRegistry(mixedRegistry());
  const out = runCli(["list"], local);
  assert.equal(out.status, 0);
  const body = JSON.parse(out.stdout);
  assert.ok(body.targets.good);
  assert.equal(body.targets.broken, undefined);
  assert.equal(body.errors.length, 1);
  assert.equal(body.errors[0].alias, "broken");
  assert.equal(body.errors[0].code, "TARGET_ENTRY_INVALID");
});

test("resolve accepts a valid alias beside a broken sibling", () => {
  const { local } = setupRegistry(mixedRegistry());
  const out = runCli(["resolve", "good"], local);
  assert.equal(out.status, 0);
  assert.equal(JSON.parse(out.stdout).target_id, "good");
});

test("resolve refuses broken and unsafe aliases without touching the file", () => {
  const { local, file } = setupRegistry(mixedRegistry());
  const before = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  for (const alias of ["broken", "../evil"]) {
    const out = runCli(["resolve", alias], local);
    assert.equal(out.status, 1);
    assert.equal(JSON.parse(out.stdout).code, "TARGET_ENTRY_INVALID");
  }
  const after = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  assert.equal(after, before);
});

test("mutating commands stay strict and never drop the broken entry", () => {
  const { local, file } = setupRegistry(mixedRegistry());
  const before = fs.readFileSync(file, "utf8");
  const out = runCli(["use", "good"], local);
  assert.equal(out.status, 1);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("invalid default fails closed instead of falling through", () => {
  const raw = mixedRegistry();
  raw.default_target = "broken";
  const { local } = setupRegistry(raw);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-target-cwd-"));
  const out = runCli(["current"], local, scratch);
  assert.equal(out.status, 1);
  assert.equal(JSON.parse(out.stdout).code, "TARGET_ENTRY_INVALID");
});

test("corrupt registry fails closed with a JSON error envelope", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-target-cli-"));
  const local = path.join(dir, "local");
  fs.mkdirSync(path.join(local, "DevExec"), { recursive: true });
  fs.writeFileSync(path.join(local, "DevExec", "targets.json"), "{oops", "utf8");
  const out = runCli(["list"], local);
  assert.equal(out.status, 1);
  assert.ok(JSON.parse(out.stdout).error);
});

test("all-valid registry keeps the legacy list contract", () => {
  const { local } = setupRegistry({ schema_version: 1, default_target: "good", targets: { good: mixedRegistry().targets.good } });
  const out = runCli(["list"], local);
  assert.equal(out.status, 0);
  const body = JSON.parse(out.stdout);
  assert.ok(body.targets.good);
  assert.deepEqual(body.errors, []);
  assert.equal(body.default_invalid, null);
});

