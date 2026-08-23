import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {verifyMissionHostEvidence} from "./devexec-mission-host-evidence-verify.mjs";

const HEAD = "24c2c37913ff39fb9dda7562decddaadaa82563f";
const REQUIRED = [
  ["00-repo-preflight.txt", "MISSION_HOST_PREFLIGHT=PASS"],
  ["01-mission-reliability.txt", "MISSION_RELIABILITY_CHECK=PASS"],
  ["02-file-identity.txt", "MISSION_FILE_IDENTITY_HOST_PROBE=PASS"],
  ["03-host-lock-process.txt", "MISSION_HOST_LOCK_ACCEPTANCE=PASS"],
  ["04-repo-postflight.txt", "MISSION_HOST_PREFLIGHT=PASS"],
];

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-host-evidence-verify-"));
  const evidenceRoot = path.join(root, "evidence");
  const missionRoot = path.join(root, "mission-base");
  fs.mkdirSync(evidenceRoot);
  fs.mkdirSync(missionRoot);

  const artifacts = REQUIRED.map(([name, marker]) => {
    const file = path.join(evidenceRoot, name);
    fs.writeFileSync(file, `component=${name}\n${marker}\n`, "utf8");
    return {path: file, sha256: sha256(file)};
  });

  const summary = {
    protocol: "devexec.mission-host-acceptance",
    schema_version: 2,
    generated_at: new Date().toISOString(),
    machine: "TEST-HOST",
    repo: path.join(root, "repo"),
    branch: "test-branch",
    head: HEAD,
    expected_head: HEAD,
    mission_probe_root: missionRoot,
    evidence_root: evidenceRoot,
    checks: {
      source_checkout_preflight_clean: "PASS",
      mission_reliability_bundle: "PASS",
      mission_filesystem_hardlink_identity: "PASS",
      mission_filesystem_real_process_live_owner_refusal_and_kill_recovery: "PASS",
      mission_filesystem_returned_thenable_cross_process_exclusion: "PASS",
      source_checkout_postflight_clean: "PASS",
      component_pass_markers: "PASS",
    },
    host_only_remainder: ["power-loss/fsync durability"],
    artifacts,
  };
  const summaryFile = path.join(evidenceRoot, "SUMMARY.json");
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2) + "\n", "utf8");

  return {
    root,
    evidenceRoot,
    missionRoot,
    summary,
    summaryFile,
    cleanup() { fs.rmSync(root, {recursive: true, force: true}); },
  };
}

function expectCode(fn, code) {
  assert.throws(fn, error => {
    assert.equal(error?.message, code);
    return true;
  });
}

test("valid host evidence verifies and writes immutable receipt bound to SUMMARY bytes", () => {
  const fx = fixture();
  try {
    const receipt = path.join(fx.evidenceRoot, "VERIFICATION.json");
    const report = verifyMissionHostEvidence(fx.summaryFile, {
      expectedHead: HEAD,
      expectedMissionProbeRoot: fx.missionRoot,
      writeReceipt: receipt,
    });
    assert.equal(report.status, "PASS");
    assert.equal(report.summary_sha256, sha256(fx.summaryFile));
    assert.equal(report.validated_artifacts.length, REQUIRED.length);
    assert.equal(fs.existsSync(receipt), true);

    const persisted = JSON.parse(fs.readFileSync(receipt, "utf8"));
    assert.equal(persisted.status, "PASS");
    assert.equal(persisted.summary_sha256, sha256(fx.summaryFile));
    assert.equal(persisted.validated_artifacts.length, REQUIRED.length);
    assert.equal(report.receipt_sha256, sha256(receipt));
  } finally {
    fx.cleanup();
  }
});

test("tampered component bytes fail closed on SHA mismatch", () => {
  const fx = fixture();
  try {
    fs.appendFileSync(fx.summary.artifacts[1].path, "tampered\n", "utf8");
    expectCode(
      () => verifyMissionHostEvidence(fx.summaryFile, {expectedHead: HEAD}),
      "MISSION_HOST_EVIDENCE_ARTIFACT_HASH_MISMATCH",
    );
  } finally {
    fx.cleanup();
  }
});

test("matching SHA is insufficient when required PASS marker is absent", () => {
  const fx = fixture();
  try {
    const artifact = fx.summary.artifacts[2];
    fs.writeFileSync(artifact.path, "no declared pass marker\n", "utf8");
    artifact.sha256 = sha256(artifact.path);
    fs.writeFileSync(fx.summaryFile, JSON.stringify(fx.summary, null, 2) + "\n", "utf8");
    expectCode(
      () => verifyMissionHostEvidence(fx.summaryFile, {expectedHead: HEAD}),
      "MISSION_HOST_EVIDENCE_ARTIFACT_MARKER_MISSING",
    );
  } finally {
    fx.cleanup();
  }
});

test("artifact path escaping the evidence root is rejected even with valid bytes and marker", () => {
  const fx = fixture();
  try {
    const outside = path.join(fx.root, "outside.txt");
    fs.writeFileSync(outside, "MISSION_RELIABILITY_CHECK=PASS\n", "utf8");
    fx.summary.artifacts[1] = {path: outside, sha256: sha256(outside)};
    fs.writeFileSync(fx.summaryFile, JSON.stringify(fx.summary, null, 2) + "\n", "utf8");
    expectCode(
      () => verifyMissionHostEvidence(fx.summaryFile, {expectedHead: HEAD}),
      "MISSION_HOST_EVIDENCE_ARTIFACT_OUTSIDE_ROOT",
    );
  } finally {
    fx.cleanup();
  }
});

test("recorded and caller-pinned commit identity must agree", () => {
  const fx = fixture();
  try {
    fx.summary.head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    fs.writeFileSync(fx.summaryFile, JSON.stringify(fx.summary, null, 2) + "\n", "utf8");
    expectCode(
      () => verifyMissionHostEvidence(fx.summaryFile, {expectedHead: HEAD}),
      "MISSION_HOST_EVIDENCE_RECORDED_HEAD_MISMATCH",
    );

    fx.summary.head = HEAD;
    fx.summary.expected_head = HEAD;
    fs.writeFileSync(fx.summaryFile, JSON.stringify(fx.summary, null, 2) + "\n", "utf8");
    expectCode(
      () => verifyMissionHostEvidence(fx.summaryFile, {
        expectedHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
      "MISSION_HOST_EVIDENCE_VERIFIER_HEAD_MISMATCH",
    );
  } finally {
    fx.cleanup();
  }
});

test("caller can pin the Mission filesystem root used by host probes", () => {
  const fx = fixture();
  try {
    const other = path.join(fx.root, "other-mission-base");
    fs.mkdirSync(other);
    expectCode(
      () => verifyMissionHostEvidence(fx.summaryFile, {
        expectedHead: HEAD,
        expectedMissionProbeRoot: other,
      }),
      "MISSION_HOST_EVIDENCE_MISSION_PROBE_ROOT_MISMATCH",
    );
  } finally {
    fx.cleanup();
  }
});

test("artifact set must be exact and duplicate-free", () => {
  const fx = fixture();
  try {
    fx.summary.artifacts[4] = {...fx.summary.artifacts[0]};
    fs.writeFileSync(fx.summaryFile, JSON.stringify(fx.summary, null, 2) + "\n", "utf8");
    expectCode(
      () => verifyMissionHostEvidence(fx.summaryFile, {expectedHead: HEAD}),
      "MISSION_HOST_EVIDENCE_ARTIFACT_DUPLICATE",
    );

    fx.summary.artifacts = fx.summary.artifacts.slice(0, 4);
    fs.writeFileSync(fx.summaryFile, JSON.stringify(fx.summary, null, 2) + "\n", "utf8");
    expectCode(
      () => verifyMissionHostEvidence(fx.summaryFile, {expectedHead: HEAD}),
      "MISSION_HOST_EVIDENCE_ARTIFACT_COUNT_MISMATCH",
    );
  } finally {
    fx.cleanup();
  }
});

test("verification receipt is immutable and is never overwritten", () => {
  const fx = fixture();
  try {
    const receipt = path.join(fx.evidenceRoot, "VERIFICATION.json");
    fs.writeFileSync(receipt, "existing\n", "utf8");
    expectCode(
      () => verifyMissionHostEvidence(fx.summaryFile, {
        expectedHead: HEAD,
        writeReceipt: receipt,
      }),
      "MISSION_HOST_EVIDENCE_RECEIPT_EXISTS",
    );
    assert.equal(fs.readFileSync(receipt, "utf8"), "existing\n");
  } finally {
    fx.cleanup();
  }
});
