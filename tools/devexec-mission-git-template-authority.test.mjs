import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {buildIsolatedGitEnvironment} from "./devexec-mission-reviewed-host-git-env.mjs";

function runGit(root, env) {
  return spawnSync("git", ["-C", root, "init", "-q"], {
    env,
    encoding: "utf8",
    windowsHide: true,
  });
}

test("GIT_TEMPLATE_DIR can inject repository metadata and the isolated environment blocks it", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-git-template-"));
  try {
    const template = path.join(base, "template");
    const contaminatedRoot = path.join(base, "contaminated");
    const isolatedRoot = path.join(base, "isolated");
    const injectedRelative = path.join("hooks", "devexec-injected-hook");
    fs.mkdirSync(path.join(template, "hooks"), {recursive: true});
    fs.mkdirSync(contaminatedRoot);
    fs.mkdirSync(isolatedRoot);
    fs.writeFileSync(path.join(template, injectedRelative), "injected\n");

    const contaminatedEnv = {
      ...process.env,
      GIT_TEMPLATE_DIR: template,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_COUNT: "0",
    };
    const contaminated = runGit(contaminatedRoot, contaminatedEnv);
    assert.equal(contaminated.status, 0, `${contaminated.stdout}\n${contaminated.stderr}`);
    assert.equal(
      fs.existsSync(path.join(contaminatedRoot, ".git", injectedRelative)),
      true,
      "precondition: inherited GIT_TEMPLATE_DIR must alter git init metadata",
    );

    const isolatedEnv = buildIsolatedGitEnvironment(contaminatedEnv);
    const isolated = runGit(isolatedRoot, isolatedEnv);
    assert.equal(isolated.status, 0, `${isolated.stdout}\n${isolated.stderr}`);
    assert.equal(
      fs.existsSync(path.join(isolatedRoot, ".git", injectedRelative)),
      false,
      "isolated child environment must not copy attacker-controlled templates",
    );
  } finally {
    fs.rmSync(base, {recursive: true, force: true});
  }
});
