import http from "node:http";
import {URL} from "node:url";

import {
  inspectAutonomousStartCapability,
  readDevExecRunState,
  startAutonomousRun,
} from "./devexec-control-service.mjs";

const HOST = "127.0.0.1";
const MAX_BODY_BYTES = 64 * 1024;
const PROTOCOL = "devexec.control.http";
const SCHEMA_VERSION = 1;

function sendJson(response, status, value) {
  const body = JSON.stringify(value);

  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });

  response.end(body);
}

function errorValue(code) {
  return {
    protocol: `${PROTOCOL}.error`,
    schema_version: SCHEMA_VERSION,
    error: code,
  };
}

function mapErrorStatus(error) {
  const code =
    error instanceof Error
      ? error.message
      : String(error);

  if (
    code === "DEVEXEC_CONTROL_RUN_STATE_MISSING" ||
    code === "MISSION_AUTONOMOUS_START_BOUNDARY_STATE_MISSING"
  ) {
    return 404;
  }

  if (
    code === "DEVEXEC_CONTROL_START_UNSAFE_BOUNDARY" ||
    code === "DEVEXEC_CONTROL_START_BLOCKED_IN_FLIGHT" ||
    code === "MISSION_AUTONOMOUS_START_UNSAFE_BOUNDARY" ||
    code === "MISSION_AUTONOMOUS_START_BLOCKED_BY_IN_FLIGHT_ACTION"
  ) {
    return 409;
  }

  if (
    code === "HTTP_JSON_CONTENT_TYPE_REQUIRED"
  ) {
    return 415;
  }

  if (
    code === "HTTP_BODY_TOO_LARGE"
  ) {
    return 413;
  }

  if (
    code === "HTTP_JSON_BODY_REQUIRED" ||
    code === "HTTP_JSON_BODY_INVALID" ||
    code === "HTTP_START_BODY_OBJECT_REQUIRED" ||
    code.startsWith("HTTP_UNKNOWN_START_FIELD:") ||
    code.endsWith(" required") ||
    code.endsWith(" invalid")
  ) {
    return 400;
  }

  return 500;
}

async function readJson(request, maxBodyBytes) {
  const contentType =
    String(request.headers["content-type"] ?? "")
      .toLowerCase();

  if (!contentType.startsWith("application/json")) {
    throw new Error("HTTP_JSON_CONTENT_TYPE_REQUIRED");
  }

  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;

    if (size > maxBodyBytes) {
      throw new Error("HTTP_BODY_TOO_LARGE");
    }

    chunks.push(bytes);
  }

  const text = Buffer.concat(chunks).toString("utf8");

  if (!text.trim()) {
    throw new Error("HTTP_JSON_BODY_REQUIRED");
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("HTTP_JSON_BODY_INVALID");
  }
}

function normalizeStartBody(body) {
  if (
    body == null ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    throw new Error("HTTP_START_BODY_OBJECT_REQUIRED");
  }

  const allowed = new Set([
    "mission_id",
    "parent_run_id",
    "child_run_id",
    "goal",
    "target_alias",
    "constraints",
    "entry_path",
    "launch_id",
    "idempotency_key",
  ]);

  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw new Error(`HTTP_UNKNOWN_START_FIELD:${key}`);
    }
  }

  return body;
}

function decodeRunId(value) {
  let decoded;

  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error("run_id invalid");
  }

  if (
    !decoded ||
    decoded.includes("/") ||
    decoded.includes("\\")
  ) {
    throw new Error("run_id invalid");
  }

  return decoded;
}

export function createDevExecControlServer({
  base,
  env = process.env,
  max_body_bytes = MAX_BODY_BYTES,
  control = {
    read_run_state: readDevExecRunState,
    inspect_capability: inspectAutonomousStartCapability,
    start_autonomous_run: startAutonomousRun,
  },
} = {}) {
  if (typeof base !== "string" || !base.trim()) {
    throw new Error("DEVEXEC_CONTROL_SERVER_BASE_REQUIRED");
  }

  return http.createServer(async (request, response) => {
    try {
      const method = request.method ?? "GET";
      const url = new URL(
        request.url ?? "/",
        "http://127.0.0.1",
      );

      if (
        method === "GET" &&
        url.pathname === "/health"
      ) {
        sendJson(response, 200, {
          protocol: `${PROTOCOL}.health`,
          schema_version: SCHEMA_VERSION,
          status: "ok",
          bind_policy: "loopback-only",
        });
        return;
      }

      const runMatch =
        url.pathname.match(/^\/v1\/runs\/([^/]+)$/);

      if (method === "GET" && runMatch) {
        const runId = decodeRunId(runMatch[1]);

        const state = control.read_run_state({
          base,
          run_id: runId,
          env,
        });

        sendJson(response, 200, {
          protocol: `${PROTOCOL}.run-state`,
          schema_version: SCHEMA_VERSION,
          state,
        });
        return;
      }

      if (
        method === "GET" &&
        url.pathname === "/v1/autonomous-start/capability"
      ) {
        const parentRunId =
          url.searchParams.get("parent_run_id");

        if (!parentRunId) {
          throw new Error("parent_run_id required");
        }

        const result = control.inspect_capability({
          base,
          parent_run_id: parentRunId,
          env,
        });

        sendJson(response, 200, result);
        return;
      }

      if (
        method === "POST" &&
        url.pathname === "/v1/autonomous-start"
      ) {
        const body = normalizeStartBody(
          await readJson(request, max_body_bytes),
        );

        const receipt =
          await control.start_autonomous_run({
            base,
            ...body,
            env,
          });

        sendJson(response, 200, receipt);
        return;
      }

      sendJson(
        response,
        404,
        errorValue("HTTP_ROUTE_NOT_FOUND"),
      );
    } catch (error) {
      const code =
        error instanceof Error
          ? error.message
          : String(error);

      sendJson(
        response,
        mapErrorStatus(error),
        errorValue(code),
      );
    }
  });
}

export async function listenDevExecControlServer({
  base,
  env = process.env,
  host = HOST,
  port = 0,
  max_body_bytes = MAX_BODY_BYTES,
  control,
} = {}) {
  if (host !== HOST) {
    throw new Error(
      "DEVEXEC_CONTROL_SERVER_LOOPBACK_ONLY"
    );
  }

  if (
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535
  ) {
    throw new Error(
      "DEVEXEC_CONTROL_SERVER_PORT_INVALID"
    );
  }

  const server = createDevExecControlServer({
    base,
    env,
    max_body_bytes,
    control,
  });

  await new Promise((resolve, reject) => {
    const onError = error => {
      server.off("listening", onListening);
      reject(error);
    };

    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, HOST);
  });

  const address = server.address();

  if (
    !address ||
    typeof address === "string" ||
    address.address !== HOST
  ) {
    if (server.listening) {
      await new Promise(resolve => server.close(resolve));
    }

    throw new Error(
      "DEVEXEC_CONTROL_SERVER_NON_LOOPBACK_BIND"
    );
  }

  return {
    protocol: `${PROTOCOL}.listener`,
    schema_version: SCHEMA_VERSION,
    host: address.address,
    port: address.port,
    url: `http://${address.address}:${address.port}`,
    server,
  };
}

export async function closeDevExecControlServer(server) {
  if (!server?.listening) {
    return;
  }

  await new Promise((resolve, reject) => {
    server.close(error => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
