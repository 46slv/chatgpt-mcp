import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
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

function request({ port, path: requestPath = "/", method = "GET", headers = {}, body = "" }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: requestPath,
      method,
      headers,
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: text }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
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

test("console rejects a foreign Host even when the TCP peer is loopback", async () => {
  const root = tempRoot();
  const server = createConsoleServer({ admissionRoot: root });
  const port = await listen(server);
  try {
    const response = await request({
      port,
      path: "/api/admissions",
      headers: { host: `attacker.example:${port}` },
    });
    assert.equal(response.status, 403);
    assert.match(response.body, /loopback Host required/);
  } finally {
    await close(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("console rejects a foreign browser Origin before a mutating control lookup", async () => {
  const root = tempRoot();
  const server = createConsoleServer({ admissionRoot: root });
  const port = await listen(server);
  try {
    const body = JSON.stringify({ admission_id: "missing-admission" });
    const response = await request({
      port,
      path: "/api/run",
      method: "POST",
      headers: {
        host: `127.0.0.1:${port}`,
        origin: "https://attacker.example",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
      body,
    });
    assert.equal(response.status, 403);
    assert.match(response.body, /loopback Origin required/);
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
