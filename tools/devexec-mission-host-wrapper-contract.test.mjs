import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const wrapper = path.join(HERE, "verify-devexec-mission-host-acceptance.ps1");
const hostLockProbe = path.join(HERE, "devexec-mission-host-lock-acceptance.mjs");
const fileIdentityProbe = path.join(HERE, "devexec-mission-file-identity-host-probe.mjs");
const evidenceVerifier = path.join(HERE, "devexec-mission-host-evidence-verify.mjs");

function read(file) {
  return fs.readFileSync(file, "utf8");
}

test("authoritative host wrapper requires a pinned ExpectedHead", () => {
  const source = read(wrapper);
  assert.match(source, /\[Parameter\(Mandatory=\$true\)\]\[string\]\$ExpectedHead/);
  assert.match(source, /ExpectedHead is required for authoritative Mission host acceptance/);
  assert.match(source, /--expected-head", \$ExpectedHead/);
});

test("host wrapper records clean checkout preflight and postflight", () => {
  const source = read(wrapper);
  assert.match(source, /00-repo-preflight/);
  assert.match(source, /04-repo-postflight/);
  assert.match(source, /source_checkout_preflight_clean = "PASS"/);
  assert.match(source, /source_checkout_postflight_clean = "PASS"/);
});

test("host wrapper requires explicit PASS markers for every component", () => {
  const source = read(wrapper);
  for (const marker of [
    "MISSION_HOST_PREFLIGHT=PASS",
    "MISSION_RELIABILITY_CHECK=PASS",
    "MISSION_FILE_IDENTITY_HOST_PROBE=PASS",
    "MISSION_HOST_LOCK_ACCEPTANCE=PASS",
  ]) {
    assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(source, /required PASS marker/);
  assert.match(source, /component_pass_markers = "PASS"/);
});

test("host wrapper creates evidence parent but never reuses a run directory", () => {
  const source = read(wrapper);
  assert.match(source, /yyyyMMdd-HHmmss-fff/);
  assert.match(source, /\[Guid\]::NewGuid\(\)/);
  assert.match(source, /New-Item -ItemType Directory -Path \$EvidenceRoot -Force -ErrorAction Stop/);
  assert.match(source, /New-Item -ItemType Directory -Path \$runDir -ErrorAction Stop/);
  assert.doesNotMatch(source, /New-Item[^\r\n]+-Force[^\r\n]+\$runDir/);
});

test("filesystem-sensitive probes are pinned to Mission base rather than EvidenceRoot", () => {
  const source = read(wrapper);
  assert.match(source, /\$missionBase = \$env:LOCALAPPDATA/);
  assert.match(source, /DEVEXEC_FILE_IDENTITY_PROBE_ROOT = \$missionBase/);
  assert.match(source, /DEVEXEC_MISSION_HOST_PROBE_ROOT = \$missionBase/);
  assert.match(source, /mission_probe_root = \$missionBase/);
  assert.doesNotMatch(source, /DEVEXEC_FILE_IDENTITY_PROBE_ROOT = \$runDir/);

  const lockSource = read(hostLockProbe);
  assert.match(lockSource, /DEVEXEC_MISSION_HOST_PROBE_ROOT/);
  assert.match(lockSource, /path\.join\(probeParent, "\.devexec-mission-host-live-kill-"\)/);
  assert.match(lockSource, /path\.join\(probeParent, "\.devexec-mission-host-thenable-"\)/);
  assert.match(lockSource, /probe_parent: probeParent/);

  const identitySource = read(fileIdentityProbe);
  assert.match(identitySource, /DEVEXEC_FILE_IDENTITY_PROBE_ROOT/);
  assert.match(identitySource, /path\.join\(parent, "\.devexec-file-identity-probe-"\)/);
});

test("overall host PASS is gated by persisted evidence readback and immutable receipt", () => {
  const source = read(wrapper);
  assert.match(source, /devexec-mission-host-evidence-verify\.mjs/);
  assert.match(source, /--summary \$summaryPath/);
  assert.match(source, /--expected-head \$ExpectedHead/);
  assert.match(source, /--expected-repo-root \$repoRoot/);
  assert.match(source, /--expected-mission-probe-root \$missionBase/);
  assert.match(source, /--receipt \$verificationPath/);
  assert.match(source, /MISSION_HOST_EVIDENCE_VERIFY=PASS/);
  assert.match(source, /VERIFICATION_SHA256=/);

  const verifierOffset = source.indexOf("devexec-mission-host-evidence-verify.mjs");
  const overallPassOffset = source.lastIndexOf('MISSION_HOST_ACCEPTANCE=PASS');
  assert.ok(verifierOffset >= 0 && overallPassOffset > verifierOffset);

  const verifierSource = read(evidenceVerifier);
  assert.match(verifierSource, /MISSION_HOST_EVIDENCE_REPO_ROOT_MISMATCH/);
  assert.match(verifierSource, /MISSION_HOST_EVIDENCE_ARTIFACT_HASH_MISMATCH/);
  assert.match(verifierSource, /MISSION_HOST_EVIDENCE_ARTIFACT_MARKER_MISSING/);
  assert.match(verifierSource, /MISSION_HOST_EVIDENCE_ARTIFACT_OUTSIDE_ROOT/);
  assert.match(verifierSource, /MISSION_HOST_EVIDENCE_RECEIPT_EXISTS/);
});
