import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const requestedBase = process.env.DEVEXEC_FILE_IDENTITY_PROBE_ROOT?.trim();
const parent = requestedBase ? path.resolve(requestedBase) : os.tmpdir();
if (!fs.existsSync(parent)) {
  throw new Error(`DEVEXEC_FILE_IDENTITY_PROBE_ROOT does not exist: ${parent}`);
}
const root = fs.mkdtempSync(path.join(parent, ".devexec-file-identity-probe-"));
try {
  const canonical = path.join(root, "canonical.lock");
  const hardLink = path.join(root, "evidence.lock");
  const copied = path.join(root, "copied.lock");

  fs.writeFileSync(canonical, "identity-probe\n", "utf8");
  fs.linkSync(canonical, hardLink);
  fs.copyFileSync(canonical, copied);

  const a = fs.statSync(canonical, {bigint: true});
  const b = fs.statSync(hardLink, {bigint: true});
  const c = fs.statSync(copied, {bigint: true});

  const report = {
    platform: process.platform,
    node: process.version,
    probe_parent: parent,
    canonical: {dev: a.dev.toString(), ino: a.ino.toString(), nlink: a.nlink.toString()},
    hard_link: {dev: b.dev.toString(), ino: b.ino.toString(), nlink: b.nlink.toString()},
    copied_file: {dev: c.dev.toString(), ino: c.ino.toString(), nlink: c.nlink.toString()},
    hard_link_identity_matches: a.dev === b.dev && a.ino === b.ino,
    hard_link_inode_nonzero: a.ino !== 0n && b.ino !== 0n,
    copied_file_identity_differs: a.dev !== c.dev || a.ino !== c.ino,
  };

  console.log(JSON.stringify(report, null, 2));
  assert.equal(report.hard_link_identity_matches, true, "hard-link paths must expose the same dev+ino identity");
  assert.equal(report.hard_link_inode_nonzero, true, "devexec recovery requires nonzero ino identity");
  assert.equal(report.copied_file_identity_differs, true, "a same-content copy must not satisfy hard-link identity");
  console.log("MISSION_FILE_IDENTITY_HOST_PROBE=PASS");
} finally {
  fs.rmSync(root, {recursive: true, force: true});
}
