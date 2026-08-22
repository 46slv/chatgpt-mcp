#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {enqueueMissionAmendment, openMissionControl} from "./devexec-mission-control.mjs";
import {loadMissionState, resolveMissionPaths} from "./devexec-mission-state.mjs";

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} required`);
  return value.trim();
}

export function enqueueMissionAmendmentRequest({
  base,
  mission_id,
  amendment_id,
  idempotency_key,
  kind,
  apply_mode,
  priority = 0,
  payload = {},
  now,
} = {}) {
  const paths = resolveMissionPaths(required(base, "base"), required(mission_id, "mission_id"));
  if (!fs.existsSync(paths.state_file)) throw new Error("MISSION_NOT_FOUND");
  const state = loadMissionState(paths.state_file);
  const control = openMissionControl({
    base,
    mission_id,
    run_id: state.current_run_id,
    now,
  });
  const result = enqueueMissionAmendment(control, {
    amendment_id: required(amendment_id, "amendment_id"),
    idempotency_key: required(idempotency_key, "idempotency_key"),
    kind: required(kind, "kind"),
    apply_mode: required(apply_mode, "apply_mode"),
    priority: Number.isInteger(priority) ? priority : Number.parseInt(priority, 10),
    payload,
    run_id: state.current_run_id,
  }, {now});
  return {
    protocol: "devexec.mission-amendment-enqueue-result",
    schema_version: 1,
    mission_id,
    run_id: state.current_run_id,
    amendment_id: result.amendment.amendment_id,
    status: result.amendment.status,
    deduplicated: result.deduplicated,
    queue_revision: result.queue.revision,
  };
}

export function parseMissionAmendArgs(argv) {
  const out = {priority: 0};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--mission") out.mission_id = argv[++i];
    else if (key === "--amendment-id") out.amendment_id = argv[++i];
    else if (key === "--idempotency-key") out.idempotency_key = argv[++i];
    else if (key === "--kind") out.kind = argv[++i];
    else if (key === "--mode") out.apply_mode = argv[++i];
    else if (key === "--priority") out.priority = Number.parseInt(argv[++i], 10);
    else if (key === "--payload-json") out.payload = JSON.parse(argv[++i]);
    else if (key === "--base") out.base = argv[++i];
    else throw new Error(`unknown argument: ${key}`);
  }
  return out;
}

async function main() {
  const parsed = parseMissionAmendArgs(process.argv.slice(2));
  const base = parsed.base || process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const missionId = parsed.mission_id || process.env.DEV_EXEC_MISSION_ID;
  const result = enqueueMissionAmendmentRequest({...parsed, base, mission_id: missionId});
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch(error => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
