import fs from "node:fs";
import path from "node:path";
import {
  SideEffectGuardError,
  deriveSideEffectFingerprint,
  inspectSideEffectFingerprint,
} from "./devexec-side-effect-fingerprint-guard.mjs";

const MAX_RECORD_BYTES = 64 * 1024;
const MAX_RECORDS = 4096;
const RECORD_NAME = /^([a-f0-9]{64})\.json$/;

function pathsFor(stateDir, equivalenceKey) {
  if (typeof stateDir !== "string" || !stateDir.trim()) {
    throw new SideEffectGuardError("SIDE_EFFECT_GUARD_STATE_DIR_REQUIRED", "stateDir is required");
  }
  const root = path.join(path.resolve(stateDir), "side-effect-fingerprints-v1");
  return {
    root,
    claim: path.join(root, "equivalence-claims-v1", `${equivalenceKey}.claim`),
  };
}

function assertPrivateRegularFile(file, { empty = false } = {}) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink?.() || stat.isReparsePoint?.() || (Number.isInteger(stat.nlink) && stat.nlink !== 1)) {
    throw new SideEffectGuardError("SIDE_EFFECT_GUARD_CORRUPT", "guard inspection found an unsafe file");
  }
  if (empty ? stat.size !== 0 : (stat.size <= 0 || stat.size > MAX_RECORD_BYTES)) {
    throw new SideEffectGuardError("SIDE_EFFECT_GUARD_CORRUPT", "guard inspection found an invalid file size");
  }
}

function validatedEquivalentRecords(stateDir, root, equivalenceKey) {
  if (!fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root).filter((name) => RECORD_NAME.test(name));
  if (entries.length > MAX_RECORDS) {
    throw new SideEffectGuardError("SIDE_EFFECT_GUARD_STATE_LIMIT", "too many guard records");
  }

  const records = [];
  for (const entry of entries) {
    const file = path.join(root, entry);
    assertPrivateRegularFile(file);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      throw new SideEffectGuardError("SIDE_EFFECT_GUARD_CORRUPT", "guard inspection found an unreadable record", { cause: error });
    }
    const derived = deriveSideEffectFingerprint(parsed?.action);
    if (`${derived.fingerprint}.json` !== entry) {
      throw new SideEffectGuardError("SIDE_EFFECT_GUARD_CORRUPT", "guard inspection found a record under the wrong fingerprint path");
    }
    const record = inspectSideEffectFingerprint({ stateDir, action: derived.action });
    if (record === null) {
      throw new SideEffectGuardError("SIDE_EFFECT_GUARD_CORRUPT", "guard inspection lost a record during validation");
    }
    if (derived.equivalence_key === equivalenceKey) records.push(record);
  }
  return records;
}

export function inspectSideEffectEquivalenceState({ stateDir, action } = {}) {
  const derived = deriveSideEffectFingerprint(action);
  const { root, claim } = pathsFor(stateDir, derived.equivalence_key);
  const claimPresent = fs.existsSync(claim);
  if (claimPresent) assertPrivateRegularFile(claim, { empty: true });

  const records = validatedEquivalentRecords(stateDir, root, derived.equivalence_key);
  if (records.length > 1) {
    throw new SideEffectGuardError("SIDE_EFFECT_GUARD_CORRUPT", "multiple records exist for one side-effect equivalence key");
  }
  if (!claimPresent && records.length === 0) return null;

  return {
    state: records.length === 0 ? "OWNER_ONLY" : "RECORDED",
    fingerprint: derived.fingerprint,
    equivalence_key: derived.equivalence_key,
    claim_present: claimPresent,
    record: records.length === 1 ? records[0] : null,
  };
}
