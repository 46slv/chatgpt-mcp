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

const installer =
  path.join(
    here,
    "install-devexec-control.ps1",
  );

function runPowerShell(args) {
  return spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      installer,
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
  "Windows user launcher installs and updates entirely in supplied user roots",
  () => {
    const temp =
      fs.mkdtempSync(
        path.join(
          os.tmpdir(),
          "devexec-control-install-",
        ),
      );

    const install =
      path.join(
        temp,
        "install",
      );

    const shortcuts =
      path.join(
        temp,
        "shortcuts",
      );

    try {
      const args = [
        "-Mode",
        "Install",
        "-RepoRoot",
        root,
        "-InstallRoot",
        install,
        "-ShortcutRoot",
        shortcuts,
      ];

      const first =
        runPowerShell(args);

      assert.equal(
        first.status,
        0,
        first.stderr ||
        first.stdout,
      );

      assert.match(
        first.stdout,
        /DEVEXEC_CONTROL_INSTALL=PASS/,
      );

      const start =
        path.join(
          install,
          "DevExec Control.cmd",
        );

      const status =
        path.join(
          install,
          "DevExec Control Status.cmd",
        );

      const stop =
        path.join(
          install,
          "DevExec Control Stop.cmd",
        );

      const manifest =
        path.join(
          install,
          "install.json",
        );

      const shortcut =
        path.join(
          shortcuts,
          "Dev Exec Control.lnk",
        );

      for (const file of [
        start,
        status,
        stop,
        manifest,
        shortcut,
      ]) {
        assert.equal(
          fs.existsSync(file),
          true,
          file,
        );
      }

      const startText =
        fs.readFileSync(
          start,
          "utf8",
        );

      assert.match(
        startText,
        /control start --open/,
      );

      const state =
        JSON.parse(
          fs.readFileSync(
            manifest,
            "utf8",
          ),
        );

      assert.equal(
        path.resolve(
          state.repo_root
        ),
        path.resolve(root),
      );

      const second =
        runPowerShell(args);

      assert.equal(
        second.status,
        0,
        second.stderr ||
        second.stdout,
      );

      assert.match(
        second.stdout,
        /DEVEXEC_CONTROL_UPDATE=PASS/,
      );

      const statusResult =
        runPowerShell([
          "-Mode",
          "Status",
          "-RepoRoot",
          root,
          "-InstallRoot",
          install,
          "-ShortcutRoot",
          shortcuts,
        ]);

      assert.equal(
        statusResult.status,
        0,
        statusResult.stderr ||
        statusResult.stdout,
      );

      assert.match(
        statusResult.stdout,
        /DEVEXEC_CONTROL_INSTALL_STATUS=PASS/,
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
