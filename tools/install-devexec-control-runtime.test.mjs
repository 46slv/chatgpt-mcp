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

const packager =
  path.join(
    here,
    "install-devexec-control-runtime.ps1",
  );

const authority =
  "c2f19252a8f64f8fbc218f1c5d7b16ae027d1c3d";

test(
  "stable runtime package binds launchers to versioned runtime rather than source workspace",
  () => {
    const temp =
      fs.mkdtempSync(
        path.join(
          os.tmpdir(),
          "devexec-stable-runtime-",
        ),
      );

    const runtimeBase =
      path.join(
        temp,
        "runtime",
      );

    const installRoot =
      path.join(
        temp,
        "install",
      );

    const shortcutRoot =
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
            packager,
            "-SourceRoot",
            root,
            "-AuthorityHead",
            authority,
            "-RuntimeBase",
            runtimeBase,
            "-InstallRoot",
            installRoot,
            "-ShortcutRoot",
            shortcutRoot,
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

      const runtimeRoot =
        path.join(
          runtimeBase,
          authority,
        );

      const manifest =
        JSON.parse(
          fs.readFileSync(
            path.join(
              installRoot,
              "install.json",
            ),
            "utf8",
          ),
        );

      assert.equal(
        path.resolve(
          manifest.repo_root
        ),
        path.resolve(
          runtimeRoot
        ),
      );

      assert.notEqual(
        path.resolve(
          manifest.repo_root
        ),
        path.resolve(root),
      );

      assert.equal(
        manifest.install_mode,
        "stable-user-runtime",
      );

      assert.equal(
        manifest.packaged_authority_head,
        authority,
      );

      assert.equal(
        path.resolve(
          manifest.source_repo_root
        ),
        path.resolve(root),
      );

      const startLauncher =
        fs.readFileSync(
          manifest.commands.start_open,
          "utf8",
        );

      assert.match(
        startLauncher,
        /control start --open/,
      );

      assert.equal(
        startLauncher.includes(
          path.join(
            root,
            "tools",
            "devexec.mjs",
          ),
        ),
        false,
      );

      assert.equal(
        startLauncher.includes(
          path.join(
            runtimeRoot,
            "tools",
            "devexec.mjs",
          ),
        ),
        true,
      );

      const checker =
        path.join(
          runtimeRoot,
          "tools",
          "devexec-control-install-check.mjs",
        );

      const check =
        spawnSync(
          process.execPath,
          [
            checker,
            "--install-root",
            installRoot,
          ],
          {
            cwd: runtimeRoot,
            encoding: "utf8",
          },
        );

      assert.equal(
        check.status,
        0,
        check.stderr ||
        check.stdout,
      );

      assert.equal(
        JSON.parse(
          check.stdout.trim()
        ).status,
        "HEALTHY",
      );

      assert.equal(
        fs.existsSync(
          path.join(
            runtimeRoot,
            "runtime-package.json",
          ),
        ),
        true,
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