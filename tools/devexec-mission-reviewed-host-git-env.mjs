import os from "node:os";

export const GIT_ROUTING_ENV_KEYS = Object.freeze([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
]);

export const GIT_CONFIG_AUTHORITY_ENV_KEYS = Object.freeze([
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_PARAMETERS",
  "GIT_ATTR_SOURCE",
  "GIT_ATTR_GLOBAL",
  "GIT_ATTR_SYSTEM",
  "GIT_TEMPLATE_DIR",
  "GIT_DEFAULT_HASH",
  "GIT_DEFAULT_REF_FORMAT",
]);

function authorityError(code, details = {}) {
  const error = new Error(code);
  Object.assign(error, details);
  return error;
}

export function inheritedGitEnvironmentContamination(env = process.env) {
  const contaminated = [];
  for (const key of [...GIT_ROUTING_ENV_KEYS, ...GIT_CONFIG_AUTHORITY_ENV_KEYS]) {
    if (Object.hasOwn(env, key)) contaminated.push(key);
  }
  if (Object.hasOwn(env, "GIT_CONFIG_COUNT") && env.GIT_CONFIG_COUNT !== "0") {
    contaminated.push("GIT_CONFIG_COUNT");
  }
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) contaminated.push(key);
  }
  return [...new Set(contaminated)].sort();
}

export function assertSafeInheritedGitEnvironment(env = process.env) {
  const contaminated = inheritedGitEnvironmentContamination(env);
  if (contaminated.length > 0) {
    throw authorityError("MISSION_RAW_SNAPSHOT_INHERITED_GIT_ENV_FORBIDDEN", {
      git_environment_variables: contaminated,
    });
  }
}

export function buildIsolatedGitEnvironment(baseEnv = process.env, {
  globalConfigPath = os.devNull,
} = {}) {
  if (typeof globalConfigPath !== "string" || globalConfigPath.length === 0) {
    throw authorityError("MISSION_GIT_ISOLATION_GLOBAL_CONFIG_PATH_REQUIRED");
  }
  const env = {...baseEnv};
  for (const key of [...GIT_ROUTING_ENV_KEYS, ...GIT_CONFIG_AUTHORITY_ENV_KEYS]) delete env[key];
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  env.GIT_CONFIG_COUNT = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = globalConfigPath;
  env.GIT_ATTR_NOSYSTEM = "1";
  env.GIT_NO_REPLACE_OBJECTS = "1";
  return env;
}
