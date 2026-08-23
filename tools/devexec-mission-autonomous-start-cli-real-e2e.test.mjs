import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const devexec = path.join(here, "devexec.mjs");

function writeParentState(base, {
  phase = "COMPLETE",
  pending = null,
} = {}) {
  const stateDir = path.join(
    base,
    "ChatGPTMCPProbe",
    "dev-exec-state",
  );

  fs.mkdirSync(stateDir, {recursive: true});

  fs.writeFileSync(
    path.join(stateDir, "RUN-ROOT.json"),
    JSON.stringify({
      run_id: "RUN-ROOT",
      phase,
      pending,
    }),
    "utf8",
  );
}

function invoke(base, child) {
  return spawnSync(
    process.execPath,
    [
      devexec,
      "autonomous-start",
      "--mission", "MISSION-CLI-E2E",
      "--parent-run", "RUN-ROOT",
      "--child-run", "RUN-CHILD",
      "--goal", "continue via devexec CLI",
      "--entry", child,
      "--target", "devexec-selfdev",
      "--constraint", "preserve reliability",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        LOCALAPPDATA: base,
      },
      windowsHide: true,
      timeout: 15000,
    },
  );
}

test("devexec autonomous-start launches exactly one real child from durable safe parent and duplicate does not replay", async () => {
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), "devexec-autonomous-cli-e2e-"),
  );

  const child = path.join(base, "child.mjs");
  const marker = path.join(base, "child.txt");

  try {
    writeParentState(base);

    fs.writeFileSync(
      child,
      [
        'import fs from "node:fs";',
        `fs.appendFileSync(${JSON.stringify(marker)}, "once\\n", "utf8");`,
      ].join("\n") + "\n",
      "utf8",
    );

    const first = invoke(base, child);

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
      await new Promise(
        resolve => setTimeout(resolve, 20),
      );
    }

    assert.equal(fs.existsSync(marker), true);
    assert.equal(
      fs.readFileSync(marker, "utf8"),
      "once\n",
    );

    const second = invoke(base, child);

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
    assert.equal(
      secondReceipt.request_deduplicated,
      true,
    );

    await new Promise(
      resolve => setTimeout(resolve, 200),
    );

    assert.equal(
      fs.readFileSync(marker, "utf8"),
      "once\n",
      "duplicate CLI invocation must not replay child",
    );
  } finally {
    fs.rmSync(base, {recursive: true, force: true});
  }
});

test("devexec autonomous-start rejects incomplete parent before child side effect", () => {
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), "devexec-autonomous-cli-unsafe-"),
  );

  const child = path.join(base, "child.mjs");
  const marker = path.join(base, "child.txt");

  try {
    writeParentState(base, {
      phase: "EXECUTING",
    });

    fs.writeFileSync(
      child,
      [
        'import fs from "node:fs";',
        `fs.appendFileSync(${JSON.stringify(marker)}, "unexpected\\n", "utf8");`,
      ].join("\n") + "\n",
      "utf8",
    );

    const result = invoke(base, child);

    assert.notEqual(result.status, 0);

    assert.match(
      result.stderr + result.stdout,
      /MISSION_AUTONOMOUS_START_UNSAFE_BOUNDARY/,
    );

    assert.equal(
      fs.existsSync(marker),
      false,
      "unsafe parent must not launch a child",
    );
  } finally {
    fs.rmSync(base, {recursive: true, force: true});
  }
});

test("devexec autonomous-start rejects pending parent before child side effect", () => {
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), "devexec-autonomous-cli-pending-"),
  );

  const child = path.join(base, "child.mjs");
  const marker = path.join(base, "child.txt");

  try {
    writeParentState(base, {
      phase: "COMPLETE",
      pending: {
        kind: "execution",
      },
    });

    fs.writeFileSync(
      child,
      [
        'import fs from "node:fs";',
        `fs.appendFileSync(${JSON.stringify(marker)}, "unexpected\\n", "utf8");`,
      ].join("\n") + "\n",
      "utf8",
    );

    const result = invoke(base, child);

    assert.notEqual(result.status, 0);

    assert.match(
      result.stderr + result.stdout,
      /MISSION_AUTONOMOUS_START_BLOCKED_BY_IN_FLIGHT_ACTION/,
    );

    assert.equal(
      fs.existsSync(marker),
      false,
      "pending parent must not launch a child",
    );
  } finally {
    fs.rmSync(base, {recursive: true, force: true});
  }
});
