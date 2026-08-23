import {spawn} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

const here =
  path.dirname(
    fileURLToPath(import.meta.url),
  );

const hostEntry =
  path.join(
    here,
    "devexec-control-host.mjs",
  );

const PROTOCOL =
  "devexec.control.lifecycle";

const SCHEMA_VERSION = 1;

function runtimeRoot(env = process.env) {
  const base =
    env.LOCALAPPDATA ??
    path.join(
      os.homedir(),
      "AppData",
      "Local",
    );

  return path.join(
    base,
    "ChatGPTMCPProbe",
    "devexec-control",
  );
}

export function controlReceiptPath(
  env = process.env,
) {
  return path.join(
    runtimeRoot(env),
    "server.json",
  );
}

function isPidAlive(pid) {
  if (
    !Number.isInteger(pid) ||
    pid <= 0
  ) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readReceipt(
  env = process.env,
) {
  const file =
    controlReceiptPath(env);

  if (!fs.existsSync(file)) {
    return null;
  }

  try {
    return {
      ...JSON.parse(
        fs.readFileSync(
          file,
          "utf8",
        ),
      ),
      receipt_file: file,
    };
  } catch {
    return {
      invalid: true,
      receipt_file: file,
    };
  }
}

export function inspectControlLifecycle({
  env = process.env,
} = {}) {
  const receipt =
    readReceipt(env);

  if (!receipt) {
    return {
      running: false,
      stale: false,
      receipt: null,
    };
  }

  if (receipt.invalid) {
    return {
      running: false,
      stale: true,
      receipt,
    };
  }

  const running =
    isPidAlive(receipt.pid);

  return {
    running,
    stale: !running,
    receipt,
  };
}

async function waitForRunningReceipt(
  env,
  expectedPid,
  timeoutMs = 10000,
) {
  const deadline =
    Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const state =
      inspectControlLifecycle({
        env,
      });

    if (
      state.running &&
      state.receipt?.pid ===
        expectedPid
    ) {
      return state.receipt;
    }

    await new Promise(
      resolve =>
        setTimeout(resolve, 25),
    );
  }

  throw new Error(
    "DEVEXEC_CONTROL_START_TIMEOUT"
  );
}

export async function startControlServer({
  base,
  port = 0,
  env = process.env,
  spawn_process = spawn,
} = {}) {
  const current =
    inspectControlLifecycle({
      env,
    });

  if (current.running) {
    return {
      protocol: PROTOCOL,
      schema_version: SCHEMA_VERSION,
      action: "start",
      already_running: true,
      ...current.receipt,
    };
  }

  if (
    current.stale &&
    current.receipt?.receipt_file &&
    fs.existsSync(
      current.receipt.receipt_file
    )
  ) {
    fs.unlinkSync(
      current.receipt.receipt_file
    );
  }

  const controlBase =
    base ??
    env.LOCALAPPDATA ??
    path.join(
      os.homedir(),
      "AppData",
      "Local",
    );

  fs.mkdirSync(
    runtimeRoot(env),
    {recursive: true},
  );

  const child =
    spawn_process(
      process.execPath,
      [
        hostEntry,
        "--base",
        controlBase,
        "--port",
        String(port),
      ],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env,
      },
    );

  if (
    !child ||
    !Number.isInteger(child.pid)
  ) {
    throw new Error(
      "DEVEXEC_CONTROL_START_NO_PID"
    );
  }

  child.unref?.();

  const receipt =
    await waitForRunningReceipt(
      env,
      child.pid,
    );

  return {
    protocol: PROTOCOL,
    schema_version: SCHEMA_VERSION,
    action: "start",
    already_running: false,
    ...receipt,
  };
}

export function statusControlServer({
  env = process.env,
} = {}) {
  const state =
    inspectControlLifecycle({
      env,
    });

  return {
    protocol: PROTOCOL,
    schema_version: SCHEMA_VERSION,
    action: "status",
    running: state.running,
    stale: state.stale,
    receipt: state.receipt,
  };
}

export async function stopControlServer({
  env = process.env,
  kill_process = process.kill,
} = {}) {
  const state =
    inspectControlLifecycle({
      env,
    });

  if (!state.receipt) {
    return {
      protocol: PROTOCOL,
      schema_version: SCHEMA_VERSION,
      action: "stop",
      stopped: false,
      already_stopped: true,
    };
  }

  if (!state.running) {
    if (
      state.receipt.receipt_file &&
      fs.existsSync(
        state.receipt.receipt_file
      )
    ) {
      fs.unlinkSync(
        state.receipt.receipt_file
      );
    }

    return {
      protocol: PROTOCOL,
      schema_version: SCHEMA_VERSION,
      action: "stop",
      stopped: false,
      already_stopped: true,
      stale_receipt: true,
    };
  }

  const pid =
    state.receipt.pid;

  kill_process(
    pid,
    "SIGTERM",
  );

  const deadline =
    Date.now() + 10000;

  while (Date.now() < deadline) {
    const next =
      inspectControlLifecycle({
        env,
      });

    if (!next.running) {
      if (
        next.receipt?.receipt_file &&
        fs.existsSync(
          next.receipt.receipt_file
        )
      ) {
        fs.unlinkSync(
          next.receipt.receipt_file
        );
      }

      return {
        protocol: PROTOCOL,
        schema_version: SCHEMA_VERSION,
        action: "stop",
        stopped: true,
        pid,
      };
    }

    await new Promise(
      resolve =>
        setTimeout(resolve, 25),
    );
  }

  throw new Error(
    "DEVEXEC_CONTROL_STOP_TIMEOUT"
  );
}

export function openControlGui({
  env = process.env,
  platform = process.platform,
  spawn_process = spawn,
} = {}) {
  const state =
    inspectControlLifecycle({
      env,
    });

  if (
    !state.running ||
    !state.receipt?.gui_url
  ) {
    throw new Error(
      "DEVEXEC_CONTROL_GUI_SERVER_NOT_RUNNING"
    );
  }

  const url =
    state.receipt.gui_url;

  let command;
  let args;

  if (platform === "win32") {
    command = "cmd.exe";
    args = [
      "/d",
      "/s",
      "/c",
      "start",
      "",
      url,
    ];
  } else if (
    platform === "darwin"
  ) {
    command = "open";
    args = [url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  const child =
    spawn_process(
      command,
      args,
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    );

  child?.unref?.();

  return {
    protocol: PROTOCOL,
    schema_version: SCHEMA_VERSION,
    action: "open",
    url,
  };
}

export async function diagnoseControlServer({
  env = process.env,
  fetch_impl = globalThis.fetch,
  timeout_ms = 2000,
} = {}) {
  const state = inspectControlLifecycle({env});

  if (!state.receipt) {
    return {
      protocol: PROTOCOL,
      schema_version: SCHEMA_VERSION,
      action: "doctor",
      status: "STOPPED",
      running: false,
      stale: false,
      receipt: null,
      recommendation: "start",
    };
  }

  if (state.stale) {
    return {
      protocol: PROTOCOL,
      schema_version: SCHEMA_VERSION,
      action: "doctor",
      status: "STALE",
      running: false,
      stale: true,
      receipt: state.receipt,
      safe_cleanup_available: true,
      recommendation: "stop",
    };
  }

  if (!state.running) {
    return {
      protocol: PROTOCOL,
      schema_version: SCHEMA_VERSION,
      action: "doctor",
      status: "STOPPED",
      running: false,
      stale: false,
      receipt: state.receipt,
      recommendation: "start",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    timeout_ms,
  );

  try {
    const response = await fetch_impl(
      state.receipt.url + "/health",
      {signal: controller.signal},
    );

    if (!response?.ok) {
      return {
        protocol: PROTOCOL,
        schema_version: SCHEMA_VERSION,
        action: "doctor",
        status: "DEGRADED",
        running: true,
        stale: false,
        receipt: state.receipt,
        health_http_status: response?.status ?? null,
        recommendation: "restart",
      };
    }

    const health = await response.json();

    if (
      health?.status !== "ok" ||
      health?.bind_policy !== "loopback-only"
    ) {
      return {
        protocol: PROTOCOL,
        schema_version: SCHEMA_VERSION,
        action: "doctor",
        status: "DEGRADED",
        running: true,
        stale: false,
        receipt: state.receipt,
        health,
        recommendation: "restart",
      };
    }

    return {
      protocol: PROTOCOL,
      schema_version: SCHEMA_VERSION,
      action: "doctor",
      status: "HEALTHY",
      running: true,
      stale: false,
      receipt: state.receipt,
      health,
      recommendation: null,
    };
  } catch (error) {
    return {
      protocol: PROTOCOL,
      schema_version: SCHEMA_VERSION,
      action: "doctor",
      status: "DEGRADED",
      running: true,
      stale: false,
      receipt: state.receipt,
      health_error:
        error instanceof Error
          ? error.message
          : String(error),
      recommendation: "restart",
    };
  } finally {
    clearTimeout(timer);
  }
}

function emit(value) {
  process.stdout.write(
    JSON.stringify(value) + "\n"
  );
}

export async function main(
  argv = process.argv.slice(2),
) {
  const command =
    argv.shift();

  if (command === "start") {
    let port = 0;
    let shouldOpen = false;

    for (
      let index = 0;
      index < argv.length;
      index += 1
    ) {
      const arg = argv[index];

      if (arg === "--port") {
        port = Number(
          argv[index + 1]
        );
        index += 1;
        continue;
      }

      if (arg === "--open") {
        shouldOpen = true;
        continue;
      }

      throw new Error(
        `Unknown control start argument: ${arg}`
      );
    }

    emit(
      await startControlServer({
        port,
      }),
    );

    if (shouldOpen) {
      emit(
        openControlGui()
      );
    }

    return;
  }

  if (command === "status") {
    emit(
      statusControlServer()
    );
    return;
  }

  if (command === "stop") {
    emit(
      await stopControlServer()
    );
    return;
  }

  if (command === "doctor") {
    emit(
      await diagnoseControlServer()
    );
    return;
  }

  if (command === "open") {
    emit(
      openControlGui()
    );
    return;
  }

  throw new Error(
    "usage: devexec control start [--port <port>] [--open] | status | doctor | stop | open"
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