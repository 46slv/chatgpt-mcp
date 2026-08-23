import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const devexec = path.join(here, "devexec.mjs");

test("devexec autonomous-start CLI launches exactly one real child and duplicate invocation does not replay", async () => {
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), "devexec-autonomous-cli-e2e-"),
  );

  const child = path.join(base, "child.mjs");
  const marker = path.join(base, "child.txt");

  try {
    fs.writeFileSync(
      child,
      [
        'import fs from "node:fs";',
        `fs.appendFileSync(${JSON.stringify(marker)}, "once\\n", "utf8");`,
      ].join("\n") + "\n",
      "utf8",
    );

    const args = [
      devexec,
      "autonomous-start",
      "--mission", "MISSION-CLI-E2E",
      "--parent-run", "RUN-ROOT",
      "--child-run", "RUN-CHILD",
      "--goal", "continue via devexec CLI",
      "--entry", child,
      "--target", "devexec-selfdev",
      "--constraint", "preserve reliability",
    ];

    const env = {
      ...process.env,
      LOCALAPPDATA: base,
    };

    const first = spawnSync(
      process.execPath,
      args,
      {
        encoding: "utf8",
        env,
        windowsHide: true,
        timeout: 15000,
      },
    );

    assert.equal(
      first.status,
      0,
      first.stderr || first.stdout,
    );

    const firstReceipt = JSON.parse(
      first.stdout.trim().split(/\r?\n/).at(-1),
    );

    assert.equal(firstReceipt.status, "LAUNCHED");
    assert.equal(firstReceipt.dispatched, true);

    const deadline = Date.now() + 10000;

    while (
      !fs.existsSync(marker) &&
      Date.now() < deadline
    ) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    assert.equal(fs.existsSync(marker), true);
    assert.equal(fs.readFileSync(marker, "utf8"), "once\n");

    const second = spawnSync(
      process.execPath,
      args,
      {
        encoding: "utf8",
        env,
        windowsHide: true,
        timeout: 15000,
      },
    );

    assert.equal(
      second.status,
      0,
      second.stderr || second.stdout,
    );

    const secondReceipt = JSON.parse(
      second.stdout.trim().split(/\r?\n/).at(-1),
    );

    assert.equal(secondReceipt.dispatched, false);
    assert.equal(secondReceipt.replay_blocked, true);
    assert.equal(secondReceipt.request_deduplicated, true);

    await new Promise(resolve => setTimeout(resolve, 200));

    assert.equal(
      fs.readFileSync(marker, "utf8"),
      "once\n",
      "duplicate CLI invocation must not replay child",
    );
  } finally {
    fs.rmSync(base, {recursive: true, force: true});
  }
});
