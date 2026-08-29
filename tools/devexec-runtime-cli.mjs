#!/usr/bin/env node
import { resolveDevExecRuntimeSelection } from "./devexec-runtime-selector.mjs";

function usage() {
  process.stderr.write("Usage: devexec runtime select [--runtime <default|cloud|local>] [--provider <existing|chatgpt|lmstudio|freetoken>] [--enabled|--disabled]\n");
}
const args = process.argv.slice(2);
const command = args.shift();
if (command !== "select") { usage(); process.exitCode = 2; }
else {
  const selection = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--runtime" || arg === "--provider") {
      const value = args[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      selection[arg.slice(2)] = value;
    } else if (arg === "--enabled") selection.enabled = true;
    else if (arg === "--disabled") selection.enabled = false;
    else throw new Error(`Unknown runtime argument: ${arg}`);
  }
  try { process.stdout.write(`${JSON.stringify(resolveDevExecRuntimeSelection(selection), null, 2)}\n`); process.exitCode = 0; }
  catch (error) { process.stderr.write(`${String(error?.message || error)}\n`); process.exitCode = 2; }
}
