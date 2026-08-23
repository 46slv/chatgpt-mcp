import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import {
  assertSafeInheritedGitEnvironment,
  buildIsolatedGitEnvironment,
  inheritedGitEnvironmentContamination,
} from "./devexec-mission-reviewed-host-git-env.mjs";

test("inherited Git routing/config authority is detected even when values are empty", () => {
  const env = {
    PATH: "x",
    GIT_DIR: "",
    GIT_WORK_TREE: "C:/foreign",
    GIT_CONFIG_PARAMETERS: "'user.name=foreign'",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "C:/hooks",
  };
  assert.deepEqual(inheritedGitEnvironmentContamination(env), [
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_VALUE_0",
    "GIT_DIR",
    "GIT_WORK_TREE",
  ]);
  assert.throws(
    () => assertSafeInheritedGitEnvironment(env),
    (error) => error.message === "MISSION_RAW_SNAPSHOT_INHERITED_GIT_ENV_FORBIDDEN"
      && error.git_environment_variables.includes("GIT_DIR"),
  );
});

test("GIT_CONFIG_COUNT=0 is allowed only when no injected key/value variables exist", () => {
  assert.deepEqual(inheritedGitEnvironmentContamination({GIT_CONFIG_COUNT: "0"}), []);
  assert.deepEqual(
    inheritedGitEnvironmentContamination({GIT_CONFIG_COUNT: "0", GIT_CONFIG_KEY_0: "a"}),
    ["GIT_CONFIG_KEY_0"],
  );
});

test("isolated Git child environment removes inherited authority and pins config/replace semantics", () => {
  const isolated = buildIsolatedGitEnvironment({
    PATH: "x",
    GIT_DIR: "C:/foreign/.git",
    GIT_CONFIG_SYSTEM: "C:/foreign/system.gitconfig",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "C:/hooks",
  });
  assert.equal(isolated.PATH, "x");
  assert.equal(Object.hasOwn(isolated, "GIT_DIR"), false);
  assert.equal(Object.hasOwn(isolated, "GIT_CONFIG_SYSTEM"), false);
  assert.equal(Object.hasOwn(isolated, "GIT_CONFIG_KEY_0"), false);
  assert.equal(Object.hasOwn(isolated, "GIT_CONFIG_VALUE_0"), false);
  assert.equal(isolated.GIT_CONFIG_COUNT, "0");
  assert.equal(isolated.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(isolated.GIT_CONFIG_GLOBAL, os.devNull);
  assert.equal(isolated.GIT_ATTR_NOSYSTEM, "1");
  assert.equal(isolated.GIT_NO_REPLACE_OBJECTS, "1");
});
