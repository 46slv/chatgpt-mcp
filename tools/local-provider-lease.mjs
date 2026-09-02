import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

/**
 * Single-host, parent-owned lease records for a local inference provider.
 *
 * A lease is deliberately a stop sign, never a distributed lock.  An expired,
 * malformed, or unprovable record is left in place and reported for human
 * recovery; this module never takes over or deletes another owner's record.
 * Raw process identities and release nonces remain private to the lease file
 * and in-memory handle.  All public results are digests and status codes.
 */
export const PROVIDER_LEASE_SCHEMA = "devexec.local-provider-lease/v1";
export const PROVIDER_LEASE_VERSION = 1;
export const MAX_LEASE_BYTES = 16 * 1024;
export const MAX_LEASE_ENTRIES = 256;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const FILE = /^([0-9a-f]{64})\.lease\.json$/;
const FILETIME = /^\d{1,20}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HANDLE = new WeakMap();

function isObject(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}
function sha(value) { return crypto.createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex"); }
function exact(value, keys, name) {
  if (!isObject(value)) throw new Error(`${name} must be an object`);
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((v, i) => v !== expected[i])) throw new Error(`${name} has unknown or missing keys`);
}
function validId(value) { return typeof value === "string" && SAFE_ID.test(value) && !value.includes(".."); }
function timestamp(value) {
  if (typeof value !== "string" || !UTC.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error("invalid lease timestamp");
  return value;
}
function processTime(value) {
  if (typeof value !== "string" || !(FILETIME.test(value) || UTC.test(value))) throw new Error("invalid process creation identity");
  if (UTC.test(value)) timestamp(value);
  return value;
}
function boundedInteger(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`invalid ${name}`);
  return value;
}
function privatePath(value, { create = false } = {}) {
  if (typeof value !== "string" || !value.trim()) throw new Error("lease state directory is required");
  const target = path.resolve(value);
  let current = path.parse(target).root;
  for (const piece of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, piece);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.isReparsePoint?.() || (Number.isInteger(stat.nlink) && stat.nlink > 1)) throw new Error("lease state path contains a link");
    } catch (error) {
      if (error?.code !== "ENOENT" || !create) throw error;
      fs.mkdirSync(current, { mode: 0o700 });
    }
  }
  const result = fs.lstatSync(target);
  if (!result.isDirectory() || result.isSymbolicLink() || result.isReparsePoint?.() || (Number.isInteger(result.nlink) && result.nlink > 1)) throw new Error("lease state directory is unsafe");
  return target;
}
function identity(stat) {
  if (!stat) return null;
  return { dev: stat.dev, ino: stat.ino, nlink: stat.nlink, size: stat.size, mtimeMs: stat.mtimeMs };
}
function sameIdentity(a, b) { return !!a && !!b && Object.keys(a).every((key) => a[key] === b[key]); }
function anchor(directory) {
  const lexical = privatePath(directory);
  const real = fs.realpathSync.native(lexical);
  if (real !== lexical) throw new Error("lease state canonical path changed");
  const stat = fs.lstatSync(lexical);
  return { lexical, real, dirIdentity: { dev: stat.dev, ino: stat.ino, nlink: stat.nlink } };
}
function checkAnchor(value) {
  privatePath(value.lexical);
  if (fs.realpathSync.native(value.lexical) !== value.real) throw new Error("lease state canonical path changed");
  const stat = fs.lstatSync(value.lexical);
  if (stat.dev !== value.dirIdentity.dev || stat.ino !== value.dirIdentity.ino || stat.nlink !== value.dirIdentity.nlink) throw new Error("lease state directory changed");
}
function readBoundedFile(filePath, expectedIdentity = null) {
  let before; let fd;
  try {
    before = fs.lstatSync(filePath);
    if (!before.isFile() || before.isSymbolicLink() || before.isReparsePoint?.() || (Number.isInteger(before.nlink) && before.nlink > 1) || before.size > MAX_LEASE_BYTES) throw new Error("lease file unsafe");
    if (expectedIdentity && !sameIdentity(expectedIdentity, identity(before))) throw new Error("lease file changed");
    let flags = fs.constants.O_RDONLY; if (fs.constants.O_NOFOLLOW) flags |= fs.constants.O_NOFOLLOW;
    fd = fs.openSync(filePath, flags);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || (Number.isInteger(opened.nlink) && opened.nlink > 1) || !sameIdentity(identity(before), identity(opened))) throw new Error("lease file changed");
    const text = fs.readFileSync(fd, "utf8");
    const after = fs.fstatSync(fd);
    if (!sameIdentity(identity(opened), identity(after))) throw new Error("lease file changed");
    return { text, fileIdentity: identity(before) };
  } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* no leak */ } }
}
function safeResult(status, keyDigest, extra = {}) { return Object.freeze({ status, key_digest: keyDigest || null, ...extra }); }
function nowIso(now) { const date = now(); if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error("invalid lease clock"); return date.toISOString(); }

const LEASE_KEYS = Object.freeze(["schema", "version", "key_digest", "provider", "device_index", "serve_port", "model_id", "run_id", "owner", "created_at", "expires_at", "nonce_digest", "release_nonce"]);
const OWNER_KEYS = Object.freeze(["pid", "process_start_time", "host_instance_digest"]);
export function validateProviderLease(value) {
  exact(value, LEASE_KEYS, "provider lease");
  if (value.schema !== PROVIDER_LEASE_SCHEMA || value.version !== PROVIDER_LEASE_VERSION) throw new Error("unsupported provider lease schema");
  if (!DIGEST.test(value.key_digest) || !validId(value.provider) || !validId(value.model_id) || !validId(value.run_id)) throw new Error("invalid provider lease identity");
  boundedInteger(value.device_index, 0, 128, "device index"); boundedInteger(value.serve_port, 1, 65535, "serve port");
  exact(value.owner, OWNER_KEYS, "lease owner"); boundedInteger(value.owner.pid, 1, 0x7fffffff, "owner pid"); processTime(value.owner.process_start_time);
  if (!DIGEST.test(value.owner.host_instance_digest)) throw new Error("invalid host instance identity");
  timestamp(value.created_at); timestamp(value.expires_at); if (Date.parse(value.expires_at) <= Date.parse(value.created_at)) throw new Error("lease expiry must follow creation");
  if (!DIGEST.test(value.nonce_digest) || typeof value.release_nonce !== "string" || !/^[0-9a-f]{64}$/.test(value.release_nonce) || sha(value.release_nonce) !== value.nonce_digest) throw new Error("invalid lease release nonce");
  const expected = providerLeaseKeyDigest({ provider: value.provider, deviceIndex: value.device_index, servePort: value.serve_port });
  if (value.key_digest !== expected) throw new Error("lease key digest mismatch");
  return value;
}
export function providerLeaseKeyDigest({ provider, deviceIndex, servePort }) {
  if (!validId(provider)) throw new Error("invalid provider id");
  boundedInteger(deviceIndex, 0, 128, "device index"); boundedInteger(servePort, 1, 65535, "serve port");
  return sha({ provider, device_index: deviceIndex, serve_port: servePort });
}

function defaultProbe() {
  const boot = (() => {
    if (process.platform !== "win32") return null;
    const code = "$x=(Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().ToFileTimeUtc();[Console]::Write($x)";
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", code], { encoding: "utf8", timeout: 1200, windowsHide: true, maxBuffer: 128 });
    return result.status === 0 && FILETIME.test(String(result.stdout).trim()) ? String(result.stdout).trim() : null;
  })();
  const host = boot ? sha(`${os.hostname()}|${boot}`) : null;
  const creation = (pid) => {
    if (process.platform !== "win32" || !Number.isInteger(pid) || pid < 1) return null;
    const code = `$p=Get-Process -Id ${pid} -ErrorAction Stop;[Console]::Write($p.StartTime.ToUniversalTime().ToFileTimeUtc())`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", code], { encoding: "utf8", timeout: 1200, windowsHide: true, maxBuffer: 128 });
    const value = String(result.stdout || "").trim(); return result.status === 0 && FILETIME.test(value) ? value : null;
  };
  return Object.freeze({
    currentOwner() { const start = creation(process.pid); return start && host ? { pid: process.pid, process_start_time: start, host_instance_digest: host } : null; },
    liveness(owner) {
      if (!owner || owner.host_instance_digest !== host || !host) return "MISMATCH";
      const start = creation(owner.pid); if (!start) return "UNAVAILABLE";
      return start === owner.process_start_time ? "LIVE" : "MISMATCH";
    },
  });
}
function validOwner(owner) { try { exact(owner, OWNER_KEYS, "lease owner"); boundedInteger(owner.pid, 1, 0x7fffffff, "owner pid"); processTime(owner.process_start_time); if (!DIGEST.test(owner.host_instance_digest)) throw new Error(); return true; } catch { return false; } }
function ownerEqual(a, b) { return validOwner(a) && validOwner(b) && a.pid === b.pid && a.process_start_time === b.process_start_time && a.host_instance_digest === b.host_instance_digest; }
function parseExisting(filePath) { const read = readBoundedFile(filePath); const value = validateProviderLease(JSON.parse(read.text)); return { value, fileIdentity: read.fileIdentity }; }
function statusExisting(existing, requested, probe, now) {
  if (existing.value.key_digest !== requested.key_digest || existing.value.provider !== requested.provider || existing.value.device_index !== requested.device_index || existing.value.serve_port !== requested.serve_port || existing.value.model_id !== requested.model_id) return "LEASE_NEEDS_ATTENTION";
  if (Date.parse(existing.value.expires_at) <= Date.parse(now)) return "STALE_CANDIDATE";
  let live; try { live = probe.liveness(existing.value.owner); } catch { live = "UNAVAILABLE"; }
  return live === "LIVE" ? "LEASE_HELD" : "LEASE_NEEDS_ATTENTION";
}

export function createProviderLeaseManager({ stateDir, livenessProbe = defaultProbe(), now = () => new Date(), ttlMs = 5 * 60_000 } = {}) {
  boundedInteger(ttlMs, 1_000, 24 * 60 * 60_000, "lease ttl");
  if (!livenessProbe || typeof livenessProbe.currentOwner !== "function" || typeof livenessProbe.liveness !== "function") throw new Error("invalid lease liveness probe");
  const root = privatePath(stateDir, { create: true });
  const directory = path.join(root, "provider-leases-v1"); privatePath(directory, { create: true });
  const rootAnchor = anchor(root); const dirAnchor = anchor(directory);
  function assertAnchors() { checkAnchor(rootAnchor); checkAnchor(dirAnchor); }
  function prepare(input) {
    if (!isObject(input) || !validId(input.provider) || !validId(input.modelId) || !validId(input.runId)) throw new Error("invalid lease request");
    const deviceIndex = boundedInteger(input.deviceIndex, 0, 128, "device index"); const servePort = boundedInteger(input.servePort, 1, 65535, "serve port");
    const owner = livenessProbe.currentOwner(); if (!validOwner(owner)) return null;
    return { provider: input.provider, model_id: input.modelId, run_id: input.runId, device_index: deviceIndex, serve_port: servePort, owner, key_digest: providerLeaseKeyDigest({ provider: input.provider, deviceIndex, servePort }) };
  }
  function acquire(input) {
    let request; try { request = prepare(input); } catch { return safeResult("LEASE_NEEDS_ATTENTION", null); }
    if (!request) return safeResult("LEASE_NEEDS_ATTENTION", null);
    try { assertAnchors(); } catch { return safeResult("LEASE_NEEDS_ATTENTION", request.key_digest); }
    const filePath = path.join(directory, `${request.key_digest}.lease.json`);
    const createdAt = nowIso(now); const expiresAt = new Date(Date.parse(createdAt) + ttlMs).toISOString(); const nonce = crypto.randomBytes(32).toString("hex");
    const lease = { schema: PROVIDER_LEASE_SCHEMA, version: PROVIDER_LEASE_VERSION, key_digest: request.key_digest, provider: request.provider, device_index: request.device_index, serve_port: request.serve_port, model_id: request.model_id, run_id: request.run_id, owner: request.owner, created_at: createdAt, expires_at: expiresAt, nonce_digest: sha(nonce), release_nonce: nonce };
    const encoded = Buffer.from(`${canonical(lease)}\n`, "utf8");
    let fd;
    try {
      fd = fs.openSync(filePath, "wx", 0o600);
      const stat = fs.fstatSync(fd); if (!stat.isFile() || (Number.isInteger(stat.nlink) && stat.nlink > 1)) throw new Error("unsafe created lease");
      fs.writeFileSync(fd, encoded); fs.fsyncSync(fd); const final = fs.fstatSync(fd);
      if (final.size !== encoded.length || final.nlink !== stat.nlink) throw new Error("lease write uncertainty");
      assertAnchors();
      const handle = Object.freeze({ status: "ACQUIRED", key_digest: request.key_digest });
      HANDLE.set(handle, Object.freeze({ filePath, keyDigest: request.key_digest, nonce, owner: request.owner, fileIdentity: identity(final) }));
      return Object.freeze({ status: "ACQUIRED", key_digest: request.key_digest, lease: handle });
    } catch (error) {
      if (error?.code !== "EEXIST") return safeResult("LEASE_NEEDS_ATTENTION", request.key_digest);
      try { assertAnchors(); const existing = parseExisting(filePath); return safeResult(statusExisting(existing, request, livenessProbe, nowIso(now)), request.key_digest); }
      catch { return safeResult("LEASE_NEEDS_ATTENTION", request.key_digest); }
    } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* no leak */ } }
  }
  function release(handle) {
    const privateHandle = HANDLE.get(handle); if (!privateHandle) return safeResult("NEEDS_ATTENTION", null);
    try {
      assertAnchors(); const existing = parseExisting(privateHandle.filePath);
      if (!sameIdentity(existing.fileIdentity, privateHandle.fileIdentity) || existing.value.key_digest !== privateHandle.keyDigest || existing.value.release_nonce !== privateHandle.nonce || !ownerEqual(existing.value.owner, privateHandle.owner)) return safeResult("NEEDS_ATTENTION", privateHandle.keyDigest);
      const current = livenessProbe.currentOwner(); if (!ownerEqual(current, privateHandle.owner)) return safeResult("NEEDS_ATTENTION", privateHandle.keyDigest);
      // A second identity check immediately before unlink makes any observed
      // replacement fail closed.  Node lacks unlink-at on Windows, so a race
      // after this point is treated as an OS-level uncertainty, never retried.
      const beforeUnlink = fs.lstatSync(privateHandle.filePath); if (!sameIdentity(privateHandle.fileIdentity, identity(beforeUnlink))) return safeResult("NEEDS_ATTENTION", privateHandle.keyDigest);
      fs.unlinkSync(privateHandle.filePath); HANDLE.delete(handle); assertAnchors(); return safeResult("RELEASED", privateHandle.keyDigest);
    } catch { return safeResult("NEEDS_ATTENTION", privateHandle.keyDigest); }
  }
  function scan({ maxEntries = MAX_LEASE_ENTRIES, maxBytes = MAX_LEASE_BYTES * MAX_LEASE_ENTRIES } = {}) {
    maxEntries = Number.isInteger(maxEntries) && maxEntries >= 0 ? Math.min(maxEntries, MAX_LEASE_ENTRIES) : MAX_LEASE_ENTRIES;
    maxBytes = Number.isInteger(maxBytes) && maxBytes >= 0 ? Math.min(maxBytes, MAX_LEASE_BYTES * MAX_LEASE_ENTRIES) : MAX_LEASE_BYTES * MAX_LEASE_ENTRIES;
    try { assertAnchors(); } catch { return { schema: PROVIDER_LEASE_SCHEMA, version: PROVIDER_LEASE_VERSION, status: "NEEDS_ATTENTION", leases: [] }; }
    let dir; const leases = []; let bytes = 0; let overflow = false;
    try {
      dir = fs.opendirSync(directory);
      for (;;) { const entry = dir.readSync(); if (entry === null) break; if (leases.length >= maxEntries) { overflow = true; break; }
        const entryDigest = sha(entry.name); const match = FILE.exec(entry.name);
        if (!match || !entry.isFile() || entry.isSymbolicLink()) { leases.push({ key_digest: null, entry_digest: entryDigest, status: "NEEDS_ATTENTION" }); continue; }
        const filePath = path.join(directory, entry.name);
        try { const existing = parseExisting(filePath); bytes += existing.fileIdentity.size; if (bytes > maxBytes) { overflow = true; break; }
          const requested = { key_digest: existing.value.key_digest, provider: existing.value.provider, device_index: existing.value.device_index, serve_port: existing.value.serve_port, model_id: existing.value.model_id };
          const status = statusExisting(existing, requested, livenessProbe, nowIso(now)); leases.push({ key_digest: existing.value.key_digest, entry_digest: entryDigest, status });
        } catch { leases.push({ key_digest: match?.[1] || null, entry_digest: entryDigest, status: "NEEDS_ATTENTION" }); }
      }
    } catch { return { schema: PROVIDER_LEASE_SCHEMA, version: PROVIDER_LEASE_VERSION, status: "NEEDS_ATTENTION", leases: [] }; }
    finally { if (dir) try { dir.closeSync(); } catch { /* no leak */ } }
    try { assertAnchors(); } catch { return { schema: PROVIDER_LEASE_SCHEMA, version: PROVIDER_LEASE_VERSION, status: "NEEDS_ATTENTION", leases }; }
    return { schema: PROVIDER_LEASE_SCHEMA, version: PROVIDER_LEASE_VERSION, status: overflow ? "BOUNDED_SCAN" : leases.some((item) => item.status === "LEASE_NEEDS_ATTENTION" || item.status === "NEEDS_ATTENTION") ? "ATTENTION" : "CLEAN", leases };
  }
  return Object.freeze({ acquire, release, scan, stateDir: directory });
}
