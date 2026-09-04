# EPHEMERA-System local runtime consumer candidate

The `local` Dev Exec runtime is an explicit candidate integration. It loads
the private `@46slv/ephemera-system-local-runtime` package only from a
machine-local cache after the exact binding in
`tools/ephemera-runtime-binding.mjs` has been materialized and verified.

Materialize the pinned artifact explicitly from the repository root:

```powershell
node tools/ephemera-runtime-materialize.mjs --cache-dir <external-cache>
```

The command fetches the pinned System commit, packs with LF Git blob bytes,
checks package identity, exports, artifact SHA-256, and the complete installed
package content manifest, installs the tarball into the external cache, and
imports the package root. Cache reuse repeats the content and loader hashes. A
missing private-repository credential, commit mismatch, artifact mismatch, or
missing cache is `BLOCKED`; there is no source-runtime fallback.

Normal `npm install`, build, cloud/default execution, and ChatGPT transport do
not depend on the private repository and do not run the materializer.

The switched local selector retains provider selection, TaskContract and
TaskBoundary validation, GPU policy, worker execution, and result formatting.
The package owns recovery admission, journal evidence, provider lease acquire /
release, and terminal lifecycle evidence. `beforeProviderLease` performs the
source boundary/GPU checks exactly once after System `PREFLIGHT` and before
provider lease acquisition; the selector exposes no lifecycle/factory/runtime
override that could bypass the materialized package. `runLocalWorkerTask`
remains the worker callback.

This branch is `CONSUMER_SWITCH_CANDIDATE` only. Main and canonical authority
remain unchanged until a separately reviewed consumer switch.
