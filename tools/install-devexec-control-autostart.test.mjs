import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import test from "node:test";

const here =
  path.dirname(
    fileURLToPath(import.meta.url),
  );

const root =
  path.dirname(here);

const autostartInstaller =
  path.join(
    here,
    "install-devexec-control-autostart.ps1",
  );

const controlInstaller =
  path.join(
    here,
    "install-devexec-control.ps1",
  );

function ps(args) {
  return spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      ...args,
    ],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    },
  );
}

test(
  "user startup bootstrap is headless, status-readable, and reversibly disabled",
  () => {
    const temp =
      fs.mkdtempSync(
        path.join(
          os.tmpdir(),
          "devexec-autostart-",
        ),
      );

    const install =
      path.join(temp, "install");

    const menu =
      path.join(temp, "menu");

    const startup =
      path.join(temp, "startup");

    try {
      const base =
        ps([
          "-File",
          controlInstaller,
          "-Mode",
          "Install",
          "-RepoRoot",
          root,
          "-InstallRoot",
          install,
          "-ShortcutRoot",
          menu,
        ]);

      assert.equal(
        base.status,
        0,
        base.stderr || base.stdout,
      );

      const manifestFile =
        path.join(
          install,
          "install.json",
        );

      const manifest =
        JSON.parse(
          fs.readFileSync(
            manifestFile,
            "utf8",
          ),
        );

      manifest.install_mode =
        "stable-user-runtime";

      manifest.packaged_authority_head =
        "7ae22906e77ae83d6125e419b2b3bf5b268562b6";

      fs.writeFileSync(
        manifestFile,
        JSON.stringify(
          manifest,
          null,
          2,
        ) + "\n",
        "utf8",
      );

      const installed =
        ps([
          "-File",
          autostartInstaller,
          "-Mode",
          "Install",
          "-InstallRoot",
          install,
          "-StartupRoot",
          startup,
        ]);

      assert.equal(
        installed.status,
        0,
        installed.stderr ||
        installed.stdout,
      );

      const enabled =
        JSON.parse(
          installed.stdout
            .trim()
            .split(/\r?\n/)
            .at(-1),
        );

      assert.equal(
        enabled.status,
        "ENABLED",
      );

      assert.equal(
        enabled.launcher_headless,
        true,
      );

      const launcher =
        fs.readFileSync(
          enabled.launcher,
          "utf8",
        );

      assert.match(
        launcher,
        /control start/,
      );

      assert.equal(
        launcher.includes("--open"),
        false,
      );

      const status =
        ps([
          "-File",
          autostartInstaller,
          "-Mode",
          "Status",
          "-InstallRoot",
          install,
          "-StartupRoot",
          startup,
        ]);

      assert.equal(
        status.status,
        0,
      );

      assert.equal(
        JSON.parse(
          status.stdout
            .trim()
            .split(/\r?\n/)
            .at(-1),
        ).status,
        "ENABLED",
      );

      const disabled =
        ps([
          "-File",
          autostartInstaller,
          "-Mode",
          "Disable",
          "-InstallRoot",
          install,
          "-StartupRoot",
          startup,
        ]);

      assert.equal(
        disabled.status,
        0,
      );

      assert.equal(
        JSON.parse(
          disabled.stdout
            .trim()
            .split(/\r?\n/)
            .at(-1),
        ).status,
        "DISABLED",
      );
    } finally {
      fs.rmSync(
        temp,
        {
          recursive: true,
          force: true,
        },
      );
    }
  },
);