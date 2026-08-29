#!/usr/bin/env node
import { captureCurrentChat, defaultRegistryPath, loadRegistry, resolveTarget, saveRegistry, setTarget, useTarget } from "./target-registry.mjs"; import { verifyTarget } from "./target-verify.mjs";

function print(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function usage() { process.stderr.write(["Usage:","  node tools/devexec-target.mjs list","  node tools/devexec-target.mjs current","  node tools/devexec-target.mjs set <alias> <chat-url>","  node tools/devexec-target.mjs use <alias>","  node tools/devexec-target.mjs capture <alias>","  node tools/devexec-target.mjs resolve [alias]",""].join("\n")); }

const [command, ...args] = process.argv.slice(2);
const registryPath = defaultRegistryPath();
const registry = loadRegistry(registryPath);

try {
  if (command === "list") {
    print({ registry_path: registryPath, default_target: registry.default_target, targets: registry.targets });
  } else if (command === "current") {
    print(resolveTarget({ registry }));
  } else if (command === "set" || command === "register") {
    const [alias, url] = args;
    if (!alias || !url) throw new Error(`${command} requires <alias> <chat-url>.`);
    setTarget(registry, alias, url); saveRegistry(registry, registryPath);
    print({ registry_path: registryPath, alias, target: registry.targets[alias] });
  } else if (command === "use") {
    const [alias] = args;
    if (!alias) throw new Error("use requires <alias>.");
    useTarget(registry, alias); saveRegistry(registry, registryPath);
    print({ registry_path: registryPath, default_target: registry.default_target, target: registry.targets[alias] });
  } else if (command === "capture") {
    const [alias = "current-chat"] = args;
    const target = await captureCurrentChat();
    setTarget(registry, alias, target.chat_url, { title: target.title, captured_at: target.captured_at });
    saveRegistry(registry, registryPath);
    print({ registry_path: registryPath, alias, target: registry.targets[alias] });
  } else if (command === "verify") { const [alias] = args; if (!alias) throw new Error("verify requires <alias>."); print(await verifyTarget(alias, { registry }));
 } else if (command === "resolve") {
    const [alias = null] = args;
    print(resolveTarget({ explicitTarget: alias, registry }));
  } else {
    usage(); process.exitCode = 2;
  }
} catch (error) {
  const payload = { error: error.message, code: error.code || "TARGET_ERROR" };
  if (error.candidates) payload.candidates = error.candidates;
  print(payload); process.exitCode = 1;
}
