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

test(
  "Windows installer creates a Doctor lifecycle launcher",
  () => {
    const temp =
      fs.mkdtempSync(
        path.join(
          os.tmpdir(),
          "devexec-doctor-install-",
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
      const result =
        spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            installer,
            "-Mode",
            "Install",
            "-RepoRoot",
            root,
            "-InstallRoot",
            install,
            "-ShortcutRoot",
            shortcuts,
          ],
          {
            cwd: root,
            encoding: "utf8",
            windowsHide: true,
          },
        );

      assert.equal(
        result.status,
        0,
        result.stderr ||
        result.stdout,
      );

      const doctor =
        path.join(
          install,
          "DevExec Control Doctor.cmd",
        );

      assert.equal(
        fs.existsSync(doctor),
        true,
      );

      assert.match(
        fs.readFileSync(
          doctor,
          "utf8",
        ),
        /control doctor/,
      );

      const manifest =
        JSON.parse(
          fs.readFileSync(
            path.join(
              install,
              "install.json",
            ),
            "utf8",
          ),
        );

      assert.equal(
        path.resolve(
          manifest.commands.doctor
        ),
        path.resolve(doctor),
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
