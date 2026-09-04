import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createConsoleServer, listAdmissions } from "./devexec-console.mjs";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "devexec-console-"));
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test("listAdmissions returns an empty list for a missing root", () => {
  const root = path.join(tempRoot(), "missing");
  assert.deepEqual(listAdmissions(root), []);
});

test("console serves the loopback UI and empty admission snapshot", async () => {
  const root = tempRoot();
  const server = createConsoleServer({ admissionRoot: root });
  const port = await listen(server);
  try {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /EPHEMERA Console/);

    const response = await fetch(`http://127.0.0.1:${port}/api/admissions`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { admissions: [] });
  } finally {
    await close(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("control endpoint fails closed for an unknown admission", async () => {
  const root = tempRoot();
  const server = createConsoleServer({ admissionRoot: root });
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ admission_id: "missing-admission" }),
    });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(typeof payload.error, "string");
    assert.ok(payload.error.length > 0);
  } finally {
    await close(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
