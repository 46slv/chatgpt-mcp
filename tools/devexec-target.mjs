#!/usr/bin/env node
import { captureCurrentChat, defaultRegistryPath, isValidTargetAlias, loadRegistry, loadRegistryLenient, resolveTarget, saveRegistry, setTarget, useTarget } from "./target-registry.mjs"; import { verifyTarget } from "./target-verify.mjs";

function print(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function usage() { process.stderr.write(["Usage:","  node tools/devexec-target.mjs list","  node tools/devexec-target.mjs current","  node tools/devexec-target.mjs set <alias> <chat-url>","  node tools/devexec-target.mjs use <alias>","  node tools/devexec-target.mjs capture <alias>","  node tools/devexec-target.mjs resolve [alias]",""].join("\n")); }

function invalidAliasError(name) {
  const error = new Error(`Target alias is not usable: ${name}`);
  error.code = "TARGET_ENTRY_INVALID";
  return error;
}

function gateAlias(alias, lenient) {
  if (!isValidTargetAlias(alias) || lenient.invalidAliases.includes(alias)) throw invalidAliasError(alias);
  return alias;
}

const [command, ...args] = process.argv.slice(2);
const registryPath = defaultRegistryPath();

try {
  if (command === "list") {
    const lenient = loadRegistryLenient(registryPath);
    print({ registry_path: registryPath, default_target: lenient.registry.default_target, default_invalid: lenient.invalidDefault, targets: lenient.registry.targets, errors: lenient.errors });
  } else if (command === "current" || command === "resolve") {
    const alias = command === "resolve" ? (args[0] || null) : null;
    const lenient = loadRegistryLenient(registryPath);
    if (alias !== null) gateAlias(alias, lenient);
    else if (lenient.invalidDefault !== null) throw invalidAliasError(lenient.invalidDefault);
    print(resolveTarget({ explicitTarget: alias, registry: lenient.registry }));
  } else if (command === "set" || command === "register") {
    const registry = loadRegistry(registryPath);
    const [alias, url] = args;
    if (!alias || !url) throw new Error(`${command} requires <alias> <chat-url>.`);
    setTarget(registry, alias, url); saveRegistry(registry, registryPath);
    print({ registry_path: registryPath, alias, target: registry.targets[alias] });
  } else if (command === "use") {
    const registry = loadRegistry(registryPath);
    const [alias] = args;
    if (!alias) throw new Error("use requires <alias>.");
    useTarget(registry, alias); saveRegistry(registry, registryPath);
    print({ registry_path: registryPath, default_target: registry.default_target, target: registry.targets[alias] });
  } else if (command === "capture") {
    const registry = loadRegistry(registryPath);
    const [alias = "current-chat"] = args;
    const target = await captureCurrentChat();
    setTarget(registry, alias, target.chat_url, { title: target.title, captured_at: target.captured_at });
    saveRegistry(registry, registryPath);
    print({ registry_path: registryPath, alias, target: registry.targets[alias] });
  } else if (command === "verify") {
    const [alias] = args;
    if (!alias) throw new Error("verify requires <alias>.");
    const lenient = loadRegistryLenient(registryPath);
    gateAlias(alias, lenient);
    print(await verifyTarget(alias, { registry: lenient.registry }));
  } else {
    usage(); process.exitCode = 2;
  }
} catch (error) {
  const payload = { error: error.message, code: error.code || "TARGET_ERROR" };
  if (error.candidates) payload.candidates = error.candidates;
  print(payload); process.exitCode = 1;
}
