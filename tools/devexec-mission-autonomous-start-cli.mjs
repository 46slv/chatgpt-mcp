import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  startMissionRunAutonomously,
} from "./devexec-mission-autonomous-start.mjs";

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} required`);
  }

  return value.trim();
}

function readValue(args, index, flag) {
  const value = args[index + 1];

  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${flag} requires a value`);
  }

  return value.trim();
}

function stableRequestId({
  mission_id,
  parent_run_id,
  child_run_id,
  goal,
  target_alias,
  constraints,
}) {
  const semantic = JSON.stringify({
    mission_id,
    parent_run_id,
    child_run_id,
    goal,
    target_alias: target_alias ?? null,
    constraints,
  });

  return crypto
    .createHash("sha256")
    .update(semantic)
    .digest("hex")
    .slice(0, 24);
}

export function parseAutonomousStartArgs(args, {
  env = process.env,
} = {}) {
  if (!Array.isArray(args)) {
    throw new Error("args required");
  }

  let missionId = env.DEV_EXEC_MISSION_ID ?? null;
  let parentRunId = env.DEV_EXEC_RUN_ID ?? null;
  let childRunId = null;
  let goal = null;
  let targetAlias = env.DEV_EXEC_TARGET_ALIAS ?? null;
  let entryPath = null;
  let launchId = null;
  let idempotencyKey = null;
  const constraints = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === "--mission") {
      missionId = readValue(args, i, arg);
      i += 1;
      continue;
    }

    if (arg === "--parent-run") {
      parentRunId = readValue(args, i, arg);
      i += 1;
      continue;
    }

    if (arg === "--child-run") {
      childRunId = readValue(args, i, arg);
      i += 1;
      continue;
    }

    if (arg === "--goal") {
      goal = readValue(args, i, arg);
      i += 1;
      continue;
    }

    if (arg === "--target") {
      targetAlias = readValue(args, i, arg);
      i += 1;
      continue;
    }

    if (arg === "--constraint") {
      constraints.push(readValue(args, i, arg));
      i += 1;
      continue;
    }

    if (arg === "--entry") {
      entryPath = readValue(args, i, arg);
      i += 1;
      continue;
    }

    if (arg === "--launch-id") {
      launchId = readValue(args, i, arg);
      i += 1;
      continue;
    }

    if (arg === "--idempotency-key") {
      idempotencyKey = readValue(args, i, arg);
      i += 1;
      continue;
    }

    throw new Error(`unknown autonomous-start option: ${arg}`);
  }

  missionId = required(missionId, "mission_id");
  parentRunId = required(parentRunId, "parent_run_id");
  childRunId = required(childRunId, "child_run_id");
  goal = required(goal, "goal");
  entryPath = required(entryPath, "entry_path");

  const semanticId = stableRequestId({
    mission_id: missionId,
    parent_run_id: parentRunId,
    child_run_id: childRunId,
    goal,
    target_alias: targetAlias,
    constraints,
  });

  return {
    mission_id: missionId,
    parent_run_id: parentRunId,
    child_run_id: childRunId,
    goal,
    target_alias: targetAlias,
    constraints,
    entry_path: path.resolve(entryPath),
    launch_id:
      launchId ?? `LAUNCH-AUTO-${semanticId}`,
    idempotency_key:
      idempotencyKey ?? `AUTONOMOUS:${semanticId}`,
  };
}

export async function runAutonomousStartCli(args, {
  env = process.env,
  base = env.LOCALAPPDATA,
  start = startMissionRunAutonomously,
  stdout = process.stdout,
} = {}) {
  const parsed = parseAutonomousStartArgs(args, {env});

  const result = await start({
    base,
    ...parsed,
    boundary: {
      safe: true,
      pending_action: false,
      ambiguous_action: false,
    },
  });

  const receipt = {
    protocol: "devexec.autonomous-start-cli",
    schema_version: 1,
    mission_id: parsed.mission_id,
    parent_run_id: parsed.parent_run_id,
    child_run_id: parsed.child_run_id,
    launch_id: parsed.launch_id,
    idempotency_key: parsed.idempotency_key,
    target_alias: parsed.target_alias,
    constraints: parsed.constraints,
    status: result.status,
    dispatched: result.dispatched,
    replay_blocked: result.replay_blocked,
    request_deduplicated:
      result.request_deduplicated === true,
    launch_receipt: result.receipt ?? result.launch?.receipt ?? null,
  };

  stdout.write(JSON.stringify(receipt) + "\n");

  return receipt;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] !== "autonomous-start") {
    throw new Error(
      "usage: autonomous-start --child-run <id> --goal <goal> --entry <path> [--mission <id>] [--parent-run <id>] [--target <alias>] [--constraint <text>] [--launch-id <id>] [--idempotency-key <key>]"
    );
  }

  return runAutonomousStartCli(argv.slice(1));
}
