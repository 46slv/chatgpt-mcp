import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

import {verifyMissionHostEvidence} from "./devexec-mission-host-evidence-verify.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const wrapper = path.join(HERE, "verify-devexec-mission-host-acceptance.ps1");
const HEAD = "8395824ef15ddf6aa7f9e84f60b1d37a1ab7dd45";
const REQUIRED = [
  ["00-repo-preflight.txt", "MISSION_HOST_PREFLIGHT=PASS"],
  ["01-mission-reliability.txt", "MISSION_RELIABILITY_CHECK=PASS"],
  ["02-file-identity.txt", "MISSION_FILE_IDENTITY_HOST_PROBE=PASS"],
  ["03-host-lock-process.txt", "MISSION_HOST_LOCK_ACCEPTANCE=PASS"],
  ["04-repo-postflight.txt", "MISSION_HOST_PREFLIGHT=PASS"],
];

function source() {
  return fs.readFileSync(wrapper, "utf8");
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-host-utf8-"));
  const evidenceRoot = path.join(root, "evidence");
  const missionRoot = path.join(root, "mission");
  fs.mkdirSync(evidenceRoot);
  fs.mkdirSync(missionRoot);

  const artifacts = REQUIRED.map(([name, marker]) => {
    const file = path.join(evidenceRoot, name);
    fs.writeFileSync(file, `${marker}\n`, "utf8");
    return {path: file, sha256: sha256(file)};
  });
  const summary = {
    protocol: "devexec.mission-host-acceptance",
    schema_version: 2,
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
    artifacts,
  };
  const summaryFile = path.join(evidenceRoot, "SUMMARY.json");
  fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
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

test("host wrapper writes evidence with strict UTF-8 without BOM", () => {
  const text = source();
  assert.match(text, /\[System\.Text\.UTF8Encoding\]::new\(\$false, \$true\)/);
  assert.match(text, /\[System\.IO\.File\]::WriteAllText\(\$Path, \$Text, \$script:Utf8NoBom\)/);
  assert.match(text, /Write-Utf8NoBom -Path \$outputFile -Text \$outputText/);
  assert.match(text, /Write-Utf8NoBom -Path \$summaryPath -Text \(\$summaryJson \+ \[Environment\]::NewLine\)/);
  assert.doesNotMatch(text, /Set-Content[^\r\n]+-Encoding UTF8/);
  assert.doesNotMatch(text, /UTF8Encoding\]\::new\(\$false\)/);
});

test("Windows PowerShell strict UTF-8 encoder rejects invalid UTF-16 instead of replacement-encoding it", {
  skip: process.platform !== "win32",
}, () => {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$enc = [System.Text.UTF8Encoding]::new($false, $true)",
    "$file = [System.IO.Path]::GetTempFileName()",
    "try {",
    "  $text = [string]([char]0xD800)",
    "  try {",
    "    [System.IO.File]::WriteAllText($file, $text, $enc)",
    "    Write-Output 'STRICT_ENCODER_DID_NOT_REJECT'",
    "    exit 3",
    "  } catch [System.Text.EncoderFallbackException] {",
    "    Write-Output 'STRICT_ENCODER_REJECTED'",
    "    exit 0",
    "  }",
    "} finally {",
    "  [System.IO.File]::Delete($file)",
    "}",
  ].join("\n");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /STRICT_ENCODER_REJECTED/);
});

test("the Windows PowerShell 5.1 UTF-8 BOM would make Node JSON.parse reject SUMMARY bytes", () => {
  const bomJson = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('{"protocol":"devexec.mission-host-acceptance"}\n', "utf8"),
  ]).toString("utf8");
  assert.throws(() => JSON.parse(bomJson), SyntaxError);
});

test("runtime verifier accepts valid non-ASCII UTF-8 and Windows CRLF markers", () => {
  const fx = fixture();
  try {
    const artifact = fx.summary.artifacts[1];
    fs.writeFileSync(
      artifact.path,
      "進捗: 正常\r\nMISSION_RELIABILITY_CHECK=PASS\r\n",
      "utf8",
    );
    artifact.sha256 = sha256(artifact.path);
    fs.writeFileSync(fx.summaryFile, `${JSON.stringify(fx.summary, null, 2)}\n`, "utf8");
    const report = verifyMissionHostEvidence(fx.summaryFile, {
      expectedHead: HEAD,
      expectedMissionProbeRoot: fx.missionRoot,
    });
    assert.equal(report.status, "PASS");
  } finally {
    fx.cleanup();
  }
});

test("runtime verifier rejects BOM-prefixed SUMMARY before semantic JSON verification", () => {
  const fx = fixture();
  try {
    const clean = fs.readFileSync(fx.summaryFile);
    fs.writeFileSync(fx.summaryFile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), clean]));
    expectCode(
      () => verifyMissionHostEvidence(fx.summaryFile, {
        expectedHead: HEAD,
        expectedMissionProbeRoot: fx.missionRoot,
      }),
      "MISSION_HOST_EVIDENCE_UTF8_BOM_FORBIDDEN",
    );
  } finally {
    fx.cleanup();
  }
});

test("runtime verifier rejects invalid UTF-8 component bytes even when recorded SHA matches", () => {
  const fx = fixture();
  try {
    const artifact = fx.summary.artifacts[1];
    fs.writeFileSync(artifact.path, Buffer.concat([
      Buffer.from("MISSION_RELIABILITY_CHECK=PASS\n", "utf8"),
      Buffer.from([0xc3, 0x28]),
    ]));
    artifact.sha256 = sha256(artifact.path);
    fs.writeFileSync(fx.summaryFile, `${JSON.stringify(fx.summary, null, 2)}\n`, "utf8");
    expectCode(
      () => verifyMissionHostEvidence(fx.summaryFile, {
        expectedHead: HEAD,
        expectedMissionProbeRoot: fx.missionRoot,
      }),
      "MISSION_HOST_EVIDENCE_UTF8_INVALID",
    );
  } finally {
    fx.cleanup();
  }
});
