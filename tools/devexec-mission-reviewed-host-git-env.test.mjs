import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import {
  assertSafeInheritedGitEnvironment,
  buildIsolatedGitEnvironment,
  inheritedGitEnvironmentContamination,
} from "./devexec-mission-reviewed-host-git-env.mjs";

test("inherited Git routing/config/init authority is detected even when values are empty", () => {
  const env = {
    PATH: "x",
    GIT_DIR: "",
    GIT_WORK_TREE: "C:/foreign",
    GIT_CONFIG_PARAMETERS: "'user.name=foreign'",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "C:/hooks",
    GIT_TEMPLATE_DIR: "C:/template",
    GIT_DEFAULT_HASH: "sha256",
    GIT_DEFAULT_REF_FORMAT: "reftable",
    GIT_ATTR_GLOBAL: "C:/attrs",
  };
  assert.deepEqual(inheritedGitEnvironmentContamination(env), [
    "GIT_ATTR_GLOBAL",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_VALUE_0",
    "GIT_DEFAULT_HASH",
    "GIT_DEFAULT_REF_FORMAT",
    "GIT_DIR",
    "GIT_TEMPLATE_DIR",
    "GIT_WORK_TREE",
  ]);
  assert.throws(
    () => assertSafeInheritedGitEnvironment(env),
    (error) => error.message === "MISSION_RAW_SNAPSHOT_INHERITED_GIT_ENV_FORBIDDEN"
      && error.git_environment_variables.includes("GIT_DIR")
      && error.git_environment_variables.includes("GIT_TEMPLATE_DIR"),
  );
});

test("authority matching and safe overrides are case-insensitive for Windows-compatible child environments", () => {
  const contaminated = inheritedGitEnvironmentContamination({
    git_dir: "C:/foreign/.git",
    Git_Template_Dir: "C:/template",
    git_config_count: "1",
    git_config_key_0: "core.hooksPath",
    git_config_value_0: "C:/hooks",
  });
  assert.deepEqual(contaminated, [
    "git_config_count",
    "git_config_key_0",
    "git_config_value_0",
    "git_dir",
    "Git_Template_Dir",
  ]);

  const isolated = buildIsolatedGitEnvironment({
    PATH: "x",
    git_dir: "C:/foreign/.git",
    Git_Template_Dir: "C:/template",
    git_config_count: "1",
    git_config_key_0: "core.hooksPath",
    git_config_value_0: "C:/hooks",
    git_config_nosystem: "0",
    git_no_replace_objects: "0",
  });
  for (const key of Object.keys(isolated)) {
    const upper = key.toUpperCase();
    assert.notEqual(upper, "GIT_DIR");
    assert.notEqual(upper, "GIT_TEMPLATE_DIR");
    assert.equal(/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(upper), false);
  }
  assert.equal(isolated.GIT_CONFIG_COUNT, "0");
  assert.equal(isolated.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(isolated.GIT_NO_REPLACE_OBJECTS, "1");
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
    GIT_TEMPLATE_DIR: "C:/template",
    GIT_DEFAULT_HASH: "sha256",
    GIT_DEFAULT_REF_FORMAT: "reftable",
    GIT_ATTR_GLOBAL: "C:/attrs-global",
    GIT_ATTR_SYSTEM: "C:/attrs-system",
  });
  assert.equal(isolated.PATH, "x");
  for (const key of [
    "GIT_DIR",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    "GIT_TEMPLATE_DIR",
    "GIT_DEFAULT_HASH",
    "GIT_DEFAULT_REF_FORMAT",
    "GIT_ATTR_GLOBAL",
    "GIT_ATTR_SYSTEM",
  ]) {
    assert.equal(Object.hasOwn(isolated, key), false, `${key} should be removed`);
  }
  assert.equal(isolated.GIT_CONFIG_COUNT, "0");
  assert.equal(isolated.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(isolated.GIT_CONFIG_GLOBAL, os.devNull);
  assert.equal(isolated.GIT_ATTR_NOSYSTEM, "1");
  assert.equal(isolated.GIT_NO_REPLACE_OBJECTS, "1");
});
