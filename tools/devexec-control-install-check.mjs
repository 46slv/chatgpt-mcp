import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROTOCOL =
  "devexec.control.install-check";

const SCHEMA_VERSION = 1;

function defaultInstallRoot(
  env = process.env,
) {
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
    "control-launcher",
  );
}

function sha256File(file) {
  return crypto
    .createHash("sha256")
    .update(
      fs.readFileSync(file)
    )
    .digest("hex");
}

function inspectFile(file) {
  const exists =
    typeof file === "string" &&
    file.length > 0 &&
    fs.existsSync(file) &&
    fs.statSync(file).isFile();

  return {
    path:
      typeof file === "string"
        ? file
        : null,
    exists,
    sha256:
      exists
        ? sha256File(file)
        : null,
  };
}

export function inspectControlInstall({
  env = process.env,
  install_root =
    defaultInstallRoot(env),
} = {}) {
  const manifestFile =
    path.join(
      install_root,
      "install.json",
    );

  if (!fs.existsSync(manifestFile)) {
    return {
      protocol: PROTOCOL,
      schema_version: SCHEMA_VERSION,
      status: "NOT_INSTALLED",
      update_required: true,
      install_root,
      problems: [
        "INSTALL_MANIFEST_MISSING",
      ],
    };
  }

  let manifest;

  try {
    manifest =
      JSON.parse(
        fs.readFileSync(
          manifestFile,
          "utf8",
        ),
      );
  } catch {
    return {
      protocol: PROTOCOL,
      schema_version: SCHEMA_VERSION,
      status: "BROKEN",
      update_required: true,
      install_root,
      manifest_file:
        manifestFile,
      problems: [
        "INSTALL_MANIFEST_INVALID",
      ],
    };
  }

  const problems = [];

  if (
    manifest.protocol !==
    "devexec.control.install"
  ) {
    problems.push(
      "INSTALL_PROTOCOL_INVALID"
    );
  }

  const repoRoot =
    manifest.repo_root;

  const nodePath =
    manifest.node_path;

  if (
    typeof repoRoot !== "string" ||
    !repoRoot
  ) {
    problems.push(
      "REPO_ROOT_MISSING"
    );
  }

  if (
    typeof nodePath !== "string" ||
    !fs.existsSync(nodePath)
  ) {
    problems.push(
      "NODE_PATH_MISSING"
    );
  }

  const commands =
    manifest.commands ?? {};

  const commandStates = {
    start_open:
      inspectFile(
        commands.start_open
      ),
    status:
      inspectFile(
        commands.status
      ),
    stop:
      inspectFile(
        commands.stop
      ),
    doctor:
      inspectFile(
        commands.doctor
      ),
    self_check:
      inspectFile(
        commands.self_check
      ),
  };

  for (
    const [
      name,
      state,
    ] of Object.entries(
      commandStates
    )
  ) {
    if (!state.exists) {
      problems.push(
        `COMMAND_MISSING:${name}`
      );
    }
  }

  const sourceFiles =
    typeof repoRoot === "string"
      ? {
          devexec:
            inspectFile(
              path.join(
                repoRoot,
                "tools",
                "devexec.mjs",
              ),
            ),

          lifecycle:
            inspectFile(
              path.join(
                repoRoot,
                "tools",
                "devexec-control.mjs",
              ),
            ),

          ui_js:
            inspectFile(
              path.join(
                repoRoot,
                "tools",
                "devexec-control-ui.js",
              ),
            ),

          installer:
            inspectFile(
              path.join(
                repoRoot,
                "tools",
                "install-devexec-control.ps1",
              ),
            ),
        }
      : {};

  for (
    const [
      key,
      state,
    ] of Object.entries(
      sourceFiles
    )
  ) {
    if (!state.exists) {
      problems.push(
        `SOURCE_MISSING:${key}`
      );
    }
  }

  const recorded =
    manifest.source_fingerprint ??
    null;

  let drift = false;

  if (!recorded) {
    problems.push(
      "SOURCE_FINGERPRINT_MISSING"
    );
    drift = true;
  } else {
    for (
      const [
        key,
        state,
      ] of Object.entries(
        sourceFiles
      )
    ) {
      if (
        state.exists &&
        typeof recorded[key] ===
          "string" &&
        recorded[key].toLowerCase() !==
          state.sha256
      ) {
        drift = true;

        problems.push(
          `SOURCE_DRIFT:${key}`
        );
      }
    }
  }

  const structural =
    problems.some(
      value =>
        !value.startsWith(
          "SOURCE_DRIFT:"
        ) &&
        value !==
          "SOURCE_FINGERPRINT_MISSING"
    );

  return {
    protocol: PROTOCOL,
    schema_version: SCHEMA_VERSION,
    status:
      structural
        ? "BROKEN"
        : drift
          ? "UPDATE_AVAILABLE"
          : "HEALTHY",
    update_required:
      structural ||
      drift,
    install_root,
    manifest_file:
      manifestFile,
    manifest,
    command_states:
      commandStates,
    source_files:
      sourceFiles,
    problems,
  };
}

export function main(
  argv =
    process.argv.slice(2),
) {
  let installRoot;

  for (
    let index = 0;
    index < argv.length;
    index += 1
  ) {
    if (
      argv[index] ===
      "--install-root"
    ) {
      installRoot =
        argv[index + 1];

      if (!installRoot) {
        throw new Error(
          "--install-root requires a path"
        );
      }

      index += 1;
      continue;
    }

    throw new Error(
      `Unknown install-check argument: ${argv[index]}`
    );
  }

  const result =
    inspectControlInstall({
      install_root:
        installRoot,
    });

  process.stdout.write(
    JSON.stringify(result) +
    "\n"
  );

  process.exit(
    result.status === "HEALTHY"
      ? 0
      : 3
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
  main();
}