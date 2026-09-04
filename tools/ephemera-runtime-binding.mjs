/**
 * Exact, reviewable binding for the private EPHEMERA-System runtime package.
 *
 * This manifest is deliberately data-only.  It does not contain a machine
 * path, registry URL, or fallback implementation.  A local run may proceed
 * only after the packed artifact at this exact System commit has been
 * materialized and verified by ephemera-runtime-materialize.mjs.
 */
export const EPHEMERA_RUNTIME_BINDING_SCHEMA = "ephemera.runtime-binding/v1";

export const EPHEMERA_RUNTIME_BINDING = Object.freeze({
  schema: EPHEMERA_RUNTIME_BINDING_SCHEMA,
  repository: "46slv/EPHEMERA-System",
  target_commit_sha: "06595be5bcb75275313f988d53901a6948b65db0",
  package_name: "@46slv/ephemera-system-local-runtime",
  package_version: "0.1.0",
  artifact_sha256: "28b10e0be02f90fa71646a9ea1cfced012bcd492a1719833ca4a8ca47b260ceb",
  // Exact installed-package content, computed from the exact LF-normalized
  // produced by the pinned System commit. Reusing a cache requires every
  // entry below to match and rejects both missing and unexpected files.
  package_files: Object.freeze({
    "package.json": "5760a995cb54b0dea06b8fc5aec003bdd45af113c79ebd922ed7ac10c8d2ff91",
    "README.md": "8c0b713fd911c02b989555853d4ff1a66cab01f9e777274894dbe514ab99c6ba",
    "tools/devexec-local-provider-lease-release.ps1": "a26ec4e0f36d26114776419c6961f5c44aa09fb6a14efdfdd2589ea9bf9d3c75",
    "tools/local-provider-lease.mjs": "a98c4cc4e21c1069e7add8597d289e6c41caacd9375d677655910c00e437796c",
    "tools/local-runtime-admission-lease.mjs": "3fd66c1d5b1cf27f6241b1ebd75eb4a2103f9e30b3c036d8a9508d1cfb92d6fd",
    "tools/local-runtime-admission-release.ps1": "7271aa07e8ac7067af9317fdfe52b03e9256a72851d4e995a8f7f1866064caa1",
    "tools/local-runtime-lifecycle.mjs": "d9cf6f0202558ff9ad6dd7cec1a70b318d34e0282790de53598d8b335090d210",
    "tools/local-runtime-recovery-consumer.mjs": "e4e501926aa9a8b56e7650dc28ebb73c383bdbfc63b306a983bb6ad21365ecf6",
    "tools/local-runtime-recovery-journal.mjs": "50e4f3407ec9ac7e814ed30ded26f5a99e91c3c9cc31c52be743c006a932b07f",
    "tools/system-local-runtime-public.mjs": "d0779b2c274928c1c779f6d3d4ac966cbba55b5e392c8d89877ac6cb8ebe05a7",
  }),
});

const SHA = /^[0-9a-f]{40}$/i;
const HASH = /^[0-9a-f]{64}$/i;
const PACKAGE_NAME = /^@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const PACKAGE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const REPOSITORY = /^[^/\s]+\/[^/\s]+$/;
const SAFE_RELATIVE_PATH = /^(?![\\/])(?:[A-Za-z0-9._-]+[\\/])*[A-Za-z0-9._-]+$/;

function fail(message, code) {
  const error = new Error(message);
  error.name = "EphemeraRuntimeBindingError";
  error.code = code;
  throw error;
}

/** Validate a binding without normalizing away an exact pin. */
export function validateEphemeraRuntimeBinding(value = EPHEMERA_RUNTIME_BINDING) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("runtime binding must be an object", "INVALID_RUNTIME_BINDING");
  if (value.schema !== EPHEMERA_RUNTIME_BINDING_SCHEMA) fail("runtime binding schema is unsupported", "INVALID_RUNTIME_BINDING_SCHEMA");
  if (typeof value.repository !== "string" || !REPOSITORY.test(value.repository)) fail("runtime binding repository is invalid", "INVALID_RUNTIME_REPOSITORY");
  if (typeof value.target_commit_sha !== "string" || !SHA.test(value.target_commit_sha)) fail("runtime binding commit must be a full SHA", "INVALID_RUNTIME_COMMIT");
  if (typeof value.package_name !== "string" || !PACKAGE_NAME.test(value.package_name)) fail("runtime binding package name is invalid", "INVALID_RUNTIME_PACKAGE");
  if (typeof value.package_version !== "string" || !PACKAGE_VERSION.test(value.package_version)) fail("runtime binding package version is invalid", "INVALID_RUNTIME_VERSION");
  if (typeof value.artifact_sha256 !== "string" || !HASH.test(value.artifact_sha256)) fail("runtime binding artifact hash must be SHA-256", "INVALID_RUNTIME_ARTIFACT_HASH");
  if (!value.package_files || typeof value.package_files !== "object" || Array.isArray(value.package_files)) {
    fail("runtime binding package file manifest is required", "INVALID_RUNTIME_PACKAGE_MANIFEST");
  }
  const packageFiles = {};
  const entries = Object.entries(value.package_files);
  if (entries.length === 0 || entries.length > 256) fail("runtime binding package file manifest is out of bounds", "INVALID_RUNTIME_PACKAGE_MANIFEST");
  for (const [relative, digest] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (typeof relative !== "string" || !SAFE_RELATIVE_PATH.test(relative) || relative.includes("..")) {
      fail("runtime binding package file path is unsafe", "INVALID_RUNTIME_PACKAGE_MANIFEST");
    }
    if (typeof digest !== "string" || !HASH.test(digest)) fail("runtime binding package file hash is invalid", "INVALID_RUNTIME_PACKAGE_MANIFEST");
    packageFiles[relative.replaceAll("\\", "/")] = digest.toLowerCase();
  }
  return Object.freeze({
    schema: value.schema,
    repository: value.repository,
    target_commit_sha: value.target_commit_sha.toLowerCase(),
    package_name: value.package_name,
    package_version: value.package_version,
    artifact_sha256: value.artifact_sha256.toLowerCase(),
    package_files: Object.freeze(packageFiles),
  });
}

validateEphemeraRuntimeBinding(EPHEMERA_RUNTIME_BINDING);
