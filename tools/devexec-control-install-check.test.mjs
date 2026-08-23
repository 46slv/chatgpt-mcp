import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import test from "node:test";

const here =
  path.dirname(
    fileURLToPath(
      import.meta.url,
    ),
  );

const root =
  path.dirname(here);

const installer =
  path.join(
    here,
    "install-devexec-control.ps1",
  );

const checker =
  path.join(
    here,
    "devexec-control-install-check.mjs",
  );

function installFixture() {
  const temp =
    fs.mkdtempSync(
      path.join(
        os.tmpdir(),
        "devexec-install-self-check-",
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

  return {
    temp,
    install,
  };
}

test(
  "self-check is healthy immediately after installation",
  () => {
    const fx =
      installFixture();

    try {
      const result =
        spawnSync(
          process.execPath,
          [
            checker,
            "--install-root",
            fx.install,
          ],
          {
            cwd: root,
            encoding: "utf8",
          },
        );

      assert.equal(
        result.status,
        0,
        result.stderr ||
        result.stdout,
      );

      const value =
        JSON.parse(
          result.stdout.trim()
        );

      assert.equal(
        value.status,
        "HEALTHY",
      );

      assert.equal(
        value.update_required,
        false,
      );

      assert.equal(
        fs.existsSync(
          path.join(
            fx.install,
            "DevExec Control Self Check.cmd",
          ),
        ),
        true,
      );
    } finally {
      fs.rmSync(
        fx.temp,
        {
          recursive: true,
          force: true,
        },
      );
    }
  },
);

test(
  "fingerprint drift is reported as UPDATE_AVAILABLE without mutation",
  () => {
    const fx =
      installFixture();

    try {
      const manifestFile =
        path.join(
          fx.install,
          "install.json",
        );

      const manifest =
        JSON.parse(
          fs.readFileSync(
            manifestFile,
            "utf8",
          ),
        );

      manifest
        .source_fingerprint
        .ui_js =
        "0".repeat(64);

      fs.writeFileSync(
        manifestFile,
        JSON.stringify(
          manifest,
          null,
          2,
        ) + "\n",
        "utf8",
      );

      const before =
        fs.readFileSync(
          manifestFile,
        );

      const result =
        spawnSync(
          process.execPath,
          [
            checker,
            "--install-root",
            fx.install,
          ],
          {
            cwd: root,
            encoding: "utf8",
          },
        );

      assert.equal(
        result.status,
        3,
      );

      const value =
        JSON.parse(
          result.stdout.trim()
        );

      assert.equal(
        value.status,
        "UPDATE_AVAILABLE",
      );

      assert.equal(
        value.update_required,
        true,
      );

      assert.deepEqual(
        fs.readFileSync(
          manifestFile,
        ),
        before,
      );
    } finally {
      fs.rmSync(
        fx.temp,
        {
          recursive: true,
          force: true,
        },
      );
    }
  },
);