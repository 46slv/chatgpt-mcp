import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  closeDevExecControlServer,
  listenDevExecControlServer,
} from "./devexec-control-server.mjs";

const PROTOCOL = "devexec.control.host";
const SCHEMA_VERSION = 1;

function runtimeRoot(env = process.env) {
  const base =
    env.LOCALAPPDATA ??
    path.join(os.homedir(), "AppData", "Local");

  return path.join(
    base,
    "ChatGPTMCPProbe",
    "devexec-control",
  );
}

export function controlReceiptPath(env = process.env) {
  return path.join(
    runtimeRoot(env),
    "server.json",
  );
}

function writeReceipt(file, value) {
  fs.mkdirSync(
    path.dirname(file),
    {recursive: true},
  );

  fs.writeFileSync(
    file,
    JSON.stringify(value, null, 2) + "\n",
    "utf8",
  );
}

export async function runControlHost({
  base,
  port = 0,
  env = process.env,
  receipt_file = controlReceiptPath(env),
} = {}) {
  if (
    typeof base !== "string" ||
    !base.trim()
  ) {
    throw new Error(
      "DEVEXEC_CONTROL_HOST_BASE_REQUIRED"
    );
  }

  const parsedPort = Number(port);

  if (
    !Number.isInteger(parsedPort) ||
    parsedPort < 0 ||
    parsedPort > 65535
  ) {
    throw new Error(
      "DEVEXEC_CONTROL_HOST_PORT_INVALID"
    );
  }

  const listener =
    await listenDevExecControlServer({
      base: base.trim(),
      env,
      port: parsedPort,
    });

  const receipt = {
    protocol: PROTOCOL,
    schema_version: SCHEMA_VERSION,
    pid: process.pid,
    host: listener.host,
    port: listener.port,
    url: listener.url,
    gui_url: listener.url + "/ui",
    base: base.trim(),
    started_at: new Date().toISOString(),
  };

  writeReceipt(
    receipt_file,
    receipt,
  );

  let closed = false;

  async function close() {
    if (closed) {
      return;
    }

    closed = true;

    await closeDevExecControlServer(
      listener.server,
    );

    if (
      fs.existsSync(receipt_file)
    ) {
      try {
        const current =
          JSON.parse(
            fs.readFileSync(
              receipt_file,
              "utf8",
            ),
          );

        if (
          current?.pid === process.pid
        ) {
          fs.unlinkSync(
            receipt_file
          );
        }
      } catch {
      }
    }
  }

  process.once(
    "SIGINT",
    () => {
      close().finally(
        () => process.exit(0)
      );
    },
  );

  process.once(
    "SIGTERM",
    () => {
      close().finally(
        () => process.exit(0)
      );
    },
  );

  return {
    receipt,
    listener,
    close,
  };
}

export async function main(
  argv = process.argv.slice(2),
) {
  let base =
    process.env.LOCALAPPDATA ??
    path.join(
      os.homedir(),
      "AppData",
      "Local",
    );

  let port = 0;

  for (
    let index = 0;
    index < argv.length;
    index += 1
  ) {
    const arg = argv[index];

    if (arg === "--base") {
      base = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--port") {
      port = Number(
        argv[index + 1]
      );
      index += 1;
      continue;
    }

    throw new Error(
      `Unknown control-host argument: ${arg}`
    );
  }

  const running =
    await runControlHost({
      base,
      port,
    });

  process.stdout.write(
    JSON.stringify(
      running.receipt
    ) + "\n"
  );
}

const invoked =
  process.argv[1] &&
  import.meta.url ===
    new URL(
      `file:///${process.argv[1]
        .replaceAll("\\", "/")}`
    ).href;

if (invoked) {
  await main();
}
