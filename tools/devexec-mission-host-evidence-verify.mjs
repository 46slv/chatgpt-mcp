import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {TextDecoder} from "node:util";

const REQUIRED_CHECKS = Object.freeze([
  "source_checkout_preflight_clean",
  "mission_reliability_bundle",
  "mission_filesystem_hardlink_identity",
  "mission_filesystem_real_process_live_owner_refusal_and_kill_recovery",
  "mission_filesystem_returned_thenable_cross_process_exclusion",
  "source_checkout_postflight_clean",
  "component_pass_markers",
]);

const REQUIRED_ARTIFACTS = Object.freeze(new Map([
  ["00-repo-preflight.txt", "MISSION_HOST_PREFLIGHT=PASS"],
  ["01-mission-reliability.txt", "MISSION_RELIABILITY_CHECK=PASS"],
  ["02-file-identity.txt", "MISSION_FILE_IDENTITY_HOST_PROBE=PASS"],
  ["03-host-lock-process.txt", "MISSION_HOST_LOCK_ACCEPTANCE=PASS"],
  ["04-repo-postflight.txt", "MISSION_HOST_PREFLIGHT=PASS"],
]));

function verificationError(code, details = {}) {
  const error = new Error(code);
  Object.assign(error, details);
  return error;
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  let real;
  try {
    real = typeof fs.realpathSync.native === "function"
      ? fs.realpathSync.native(resolved)
      : fs.realpathSync(resolved);
  } catch (cause) {
    throw verificationError("MISSION_HOST_EVIDENCE_PATH_UNAVAILABLE", {cause, path: resolved});
  }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function decodeUtf8NoBom(bytes, file) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw verificationError("MISSION_HOST_EVIDENCE_UTF8_BOM_FORBIDDEN", {path: file});
  }
  try {
    return new TextDecoder("utf-8", {fatal: true}).decode(bytes);
  } catch (cause) {
    throw verificationError("MISSION_HOST_EVIDENCE_UTF8_INVALID", {cause, path: file});
  }
}

function readSnapshot(file) {
  try {
    const bytes = fs.readFileSync(file);
    return {
      bytes,
      text: decodeUtf8NoBom(bytes, file),
      sha256: sha256Bytes(bytes),
    };
  } catch (cause) {
    if (cause?.message === "MISSION_HOST_EVIDENCE_UTF8_BOM_FORBIDDEN" ||
        cause?.message === "MISSION_HOST_EVIDENCE_UTF8_INVALID") {
      throw cause;
    }
    throw verificationError("MISSION_HOST_EVIDENCE_READ_FAILED", {cause, path: file});
  }
}

function hasExactMarker(text, marker) {
  return String(text ?? "").split(/\r?\n/).some(line => line.trim() === marker);
}

function ensureString(value, code, details = {}) {
  if (typeof value !== "string" || !value.trim()) throw verificationError(code, details);
  return value.trim();
}

function samePath(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function pathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

export function verifyMissionHostEvidence(summaryPath, {
  expectedHead = "",
  expectedMissionProbeRoot = "",
  expectedRepoRoot = "",
  writeReceipt = "",
} = {}) {
  const summaryFile = canonicalPath(summaryPath);
  const summaryDir = canonicalPath(path.dirname(summaryFile));
  const summarySnapshot = readSnapshot(summaryFile);
  let summary;
  try {
    // Parse and hash one immutable in-memory byte snapshot. Parsing the file and
    // hashing it through separate filesystem reads would allow a concurrent
    // rewrite to make the receipt hash refer to bytes other than those verified.
    summary = JSON.parse(summarySnapshot.text);
  } catch (cause) {
    throw verificationError("MISSION_HOST_EVIDENCE_SUMMARY_INVALID", {cause, summary_file: summaryFile});
  }

  if (summary?.protocol !== "devexec.mission-host-acceptance" || summary.schema_version !== 2) {
    throw verificationError("MISSION_HOST_EVIDENCE_SUMMARY_PROTOCOL_MISMATCH", {
      protocol: summary?.protocol ?? null,
      schema_version: summary?.schema_version ?? null,
    });
  }

  const recordedEvidenceRoot = canonicalPath(
    ensureString(summary.evidence_root, "MISSION_HOST_EVIDENCE_ROOT_REQUIRED"),
  );
  if (!samePath(recordedEvidenceRoot, summaryDir)) {
    throw verificationError("MISSION_HOST_EVIDENCE_ROOT_MISMATCH", {
      recorded_evidence_root: recordedEvidenceRoot,
      summary_directory: summaryDir,
    });
  }

  const recordedHead = ensureString(summary.head, "MISSION_HOST_EVIDENCE_HEAD_REQUIRED");
  const recordedExpectedHead = ensureString(
    summary.expected_head,
    "MISSION_HOST_EVIDENCE_EXPECTED_HEAD_REQUIRED",
  );
  if (recordedHead !== recordedExpectedHead) {
    throw verificationError("MISSION_HOST_EVIDENCE_RECORDED_HEAD_MISMATCH", {
      head: recordedHead,
      expected_head: recordedExpectedHead,
    });
  }

  const expected = ensureString(
    expectedHead,
    "MISSION_HOST_EVIDENCE_VERIFIER_EXPECTED_HEAD_REQUIRED",
  );
  if (recordedHead !== expected) {
    throw verificationError("MISSION_HOST_EVIDENCE_VERIFIER_HEAD_MISMATCH", {
      expected_head: expected,
      recorded_head: recordedHead,
    });
  }

  let recordedRepoRoot = null;
  if (expectedRepoRoot) {
    recordedRepoRoot = canonicalPath(
      ensureString(summary.repo, "MISSION_HOST_EVIDENCE_REPO_ROOT_REQUIRED"),
    );
    const expectedRepositoryRoot = canonicalPath(expectedRepoRoot);
    if (!samePath(recordedRepoRoot, expectedRepositoryRoot)) {
      throw verificationError("MISSION_HOST_EVIDENCE_REPO_ROOT_MISMATCH", {
        expected_repo_root: expectedRepositoryRoot,
        recorded_repo_root: recordedRepoRoot,
      });
    }
  }

  const missionProbeRoot = canonicalPath(
    ensureString(summary.mission_probe_root, "MISSION_HOST_EVIDENCE_MISSION_PROBE_ROOT_REQUIRED"),
  );
  if (expectedMissionProbeRoot) {
    const expectedRoot = canonicalPath(expectedMissionProbeRoot);
    if (!samePath(missionProbeRoot, expectedRoot)) {
      throw verificationError("MISSION_HOST_EVIDENCE_MISSION_PROBE_ROOT_MISMATCH", {
        expected_mission_probe_root: expectedRoot,
        recorded_mission_probe_root: missionProbeRoot,
      });
    }
  }

  if (!summary.checks || typeof summary.checks !== "object" || Array.isArray(summary.checks)) {
    throw verificationError("MISSION_HOST_EVIDENCE_CHECKS_INVALID");
  }
  for (const name of REQUIRED_CHECKS) {
    if (summary.checks[name] !== "PASS") {
      throw verificationError("MISSION_HOST_EVIDENCE_CHECK_NOT_PASS", {
        check: name,
        value: summary.checks[name] ?? null,
      });
    }
  }

  if (!Array.isArray(summary.artifacts)) {
    throw verificationError("MISSION_HOST_EVIDENCE_ARTIFACTS_INVALID");
  }
  if (summary.artifacts.length !== REQUIRED_ARTIFACTS.size) {
    throw verificationError("MISSION_HOST_EVIDENCE_ARTIFACT_COUNT_MISMATCH", {
      expected: REQUIRED_ARTIFACTS.size,
      observed: summary.artifacts.length,
    });
  }

  const validatedArtifacts = [];
  const seenNames = new Set();
  for (const artifact of summary.artifacts) {
    if (!artifact || typeof artifact !== "object") {
      throw verificationError("MISSION_HOST_EVIDENCE_ARTIFACT_INVALID");
    }
    const recordedPath = ensureString(
      artifact.path,
      "MISSION_HOST_EVIDENCE_ARTIFACT_PATH_REQUIRED",
    );
    const artifactFile = canonicalPath(recordedPath);
    if (!pathInside(summaryDir, artifactFile)) {
      throw verificationError("MISSION_HOST_EVIDENCE_ARTIFACT_OUTSIDE_ROOT", {
        artifact_path: artifactFile,
        evidence_root: summaryDir,
      });
    }

    const name = path.basename(artifactFile);
    const requiredMarker = REQUIRED_ARTIFACTS.get(name);
    if (!requiredMarker) {
      throw verificationError("MISSION_HOST_EVIDENCE_ARTIFACT_UNEXPECTED", {artifact: name});
    }
    if (seenNames.has(name)) {
      throw verificationError("MISSION_HOST_EVIDENCE_ARTIFACT_DUPLICATE", {artifact: name});
    }
    seenNames.add(name);

    const recordedHash = ensureString(
      artifact.sha256,
      "MISSION_HOST_EVIDENCE_ARTIFACT_HASH_REQUIRED",
      {artifact: name},
    ).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(recordedHash)) {
      throw verificationError("MISSION_HOST_EVIDENCE_ARTIFACT_HASH_INVALID", {
        artifact: name,
        sha256: recordedHash,
      });
    }

    // Hash and inspect the PASS marker from one in-memory snapshot so both
    // assertions are about exactly the same bytes. The snapshot decoder is
    // strict UTF-8 without BOM to keep byte evidence and interpreted evidence
    // on one canonical text contract.
    const artifactSnapshot = readSnapshot(artifactFile);
    if (artifactSnapshot.sha256 !== recordedHash) {
      throw verificationError("MISSION_HOST_EVIDENCE_ARTIFACT_HASH_MISMATCH", {
        artifact: name,
        expected_sha256: recordedHash,
        actual_sha256: artifactSnapshot.sha256,
      });
    }
    if (!hasExactMarker(artifactSnapshot.text, requiredMarker)) {
      throw verificationError("MISSION_HOST_EVIDENCE_ARTIFACT_MARKER_MISSING", {
        artifact: name,
        marker: requiredMarker,
      });
    }
    validatedArtifacts.push({
      name,
      path: artifactFile,
      sha256: artifactSnapshot.sha256,
      marker: requiredMarker,
    });
  }

  for (const requiredName of REQUIRED_ARTIFACTS.keys()) {
    if (!seenNames.has(requiredName)) {
      throw verificationError("MISSION_HOST_EVIDENCE_ARTIFACT_MISSING", {artifact: requiredName});
    }
  }

  const report = {
    protocol: "devexec.mission-host-evidence-verification",
    schema_version: 1,
    verified_at: new Date().toISOString(),
    summary_file: summaryFile,
    summary_sha256: summarySnapshot.sha256,
    expected_head: expected,
    recorded_head: recordedHead,
    repo_root: recordedRepoRoot,
    mission_probe_root: missionProbeRoot,
    evidence_root: summaryDir,
    validated_artifacts: validatedArtifacts,
    status: "PASS",
  };

  if (writeReceipt) {
    const receiptPath = path.resolve(writeReceipt);
    const receiptParent = canonicalPath(path.dirname(receiptPath));
    if (!samePath(receiptParent, summaryDir)) {
      throw verificationError("MISSION_HOST_EVIDENCE_RECEIPT_ROOT_MISMATCH", {
        receipt_path: receiptPath,
        evidence_root: summaryDir,
      });
    }
    if (fs.existsSync(receiptPath)) {
      throw verificationError("MISSION_HOST_EVIDENCE_RECEIPT_EXISTS", {
        receipt_path: receiptPath,
      });
    }

    const tmp = `${receiptPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    const payload = `${JSON.stringify(report, null, 2)}\n`;
    let fd;
    try {
      fd = fs.openSync(tmp, "wx", 0o600);
      fs.writeFileSync(fd, payload, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
    } catch (cause) {
      if (fd != null) {
        try { fs.closeSync(fd); } catch {}
      }
      try { fs.rmSync(tmp, {force: true}); } catch {}
      throw verificationError("MISSION_HOST_EVIDENCE_RECEIPT_WRITE_FAILED", {
        cause,
        receipt_path: receiptPath,
      });
    }

    try {
      // Publish without replacement. renameSync() would overwrite an existing
      // destination on POSIX if a competing verifier won the race after the
      // earlier exists check. A hard link gives an atomic create-if-absent
      // boundary while preserving the already-fsynced receipt bytes.
      fs.linkSync(tmp, receiptPath);
    } catch (cause) {
      try { fs.rmSync(tmp, {force: true}); } catch {}
      if (cause?.code === "EEXIST" || fs.existsSync(receiptPath)) {
        throw verificationError("MISSION_HOST_EVIDENCE_RECEIPT_EXISTS", {
          cause,
          receipt_path: receiptPath,
        });
      }
      throw verificationError("MISSION_HOST_EVIDENCE_RECEIPT_ATOMIC_PUBLISH_FAILED", {
        cause,
        receipt_path: receiptPath,
        fs_code: cause?.code ?? null,
      });
    }
    try { fs.rmSync(tmp, {force: true}); } catch {}

    report.receipt_file = receiptPath;
    report.receipt_sha256 = readSnapshot(receiptPath).sha256;
  }

  return report;
}

function parseCli(argv) {
  let summary = "";
  let expectedHead = "";
  let expectedMissionProbeRoot = "";
  let expectedRepoRoot = "";
  let receipt = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--summary") summary = argv[++index] ?? "";
    else if (arg === "--expected-head") expectedHead = argv[++index] ?? "";
    else if (arg === "--expected-mission-probe-root") {
      expectedMissionProbeRoot = argv[++index] ?? "";
    } else if (arg === "--expected-repo-root") {
      expectedRepoRoot = argv[++index] ?? "";
    } else if (arg === "--receipt") receipt = argv[++index] ?? "";
    else throw verificationError("MISSION_HOST_EVIDENCE_UNKNOWN_ARGUMENT", {argument: arg});
  }
  return {summary, expectedHead, expectedMissionProbeRoot, expectedRepoRoot, receipt};
}

const isMain = process.argv[1]
  ? path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
  : false;

if (isMain) {
  try {
    const args = parseCli(process.argv.slice(2));
    const report = verifyMissionHostEvidence(args.summary, {
      expectedHead: args.expectedHead,
      expectedMissionProbeRoot: args.expectedMissionProbeRoot,
      expectedRepoRoot: args.expectedRepoRoot,
      writeReceipt: args.receipt,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write("MISSION_HOST_EVIDENCE_VERIFY=PASS\n");
  } catch (error) {
    const report = {
      protocol: "devexec.mission-host-evidence-verification-error",
      schema_version: 1,
      error: error?.message || String(error),
      details: Object.fromEntries(
        Object.entries(error ?? {}).filter(([key]) => key !== "cause"),
      ),
    };
    process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 2;
  }
}
