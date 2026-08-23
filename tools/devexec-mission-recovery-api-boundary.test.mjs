import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const legacySymbol = "recoverStaleMissionLock";
const allowed = new Set([
  "devexec-mission-lock.mjs",
  "devexec-mission-recovery-interlock-probe.mjs",
]);

test("no production Mission runtime calls the retired legacy recovery mutator", () => {
  const offenders = [];
  for (const name of fs.readdirSync(toolsDir).sort()) {
    if (!name.endsWith(".mjs")) continue;
    if (name.endsWith(".test.mjs")) continue;
    if (allowed.has(name)) continue;
    const source = fs.readFileSync(path.join(toolsDir, name), "utf8");
    if (source.includes(legacySymbol)) offenders.push(name);
  }

  assert.deepEqual(
    offenders,
    [],
    `retired ${legacySymbol} must not be used by production runtime modules: ${offenders.join(", ")}`,
  );
});
