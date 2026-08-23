# Dev Exec Control Plane

Status: DEV-004

## Decision

Build one typed Control Service before adding server or GUI transport.

The server and GUI must be thin adapters. They may not manipulate Mission
persistence, launch records, safety boundaries, or child processes directly.

## Layering

1. Mission durability and launch primitives
2. `startMissionRunAutonomously`
3. `devexec-control-service.mjs`
4. transport adapters
   - CLI
   - local HTTP / IPC server
   - GUI
5. presentation

## Initial Control API

### `readDevExecRunState`

Reads exact durable parent run state and fails closed on missing, invalid, or
identity-mismatched state.

### `inspectAutonomousStartCapability`

Returns:

- parent run identity;
- phase;
- durable boundary;
- whether autonomous start is currently permitted.

### `startAutonomousRun`

Delegates through the existing typed Mission autonomous-start API only.

It returns a typed receipt containing:

- mission and lineage identity;
- launch and idempotency identity;
- target and constraints;
- dispatch state;
- replay-protection state;
- durable launch receipt.

## Safety invariants

- Missing parent state fails closed.
- Incomplete parent cannot start.
- Pending or ambiguous parent cannot start.
- GUI/server cannot fabricate safety.
- No transport may call Mission launcher primitives directly.
- Duplicate requests remain idempotent and no-replay.
- One typed Mission launch implementation remains authoritative.

## Next boundary

Implement a localhost-only transport adapter over this Control Service.

Initial endpoints / operations:

- health + protocol version;
- read run state;
- inspect autonomous-start capability;
- request autonomous child RUN.

First server version must:

- bind loopback only;
- introduce no remote exposure;
- use JSON schemas;
- perform no launch logic itself;
- call only the Control Service.

After transport E2E passes, build the GUI as a thin client.

## Localhost transport

Implemented as a loopback-only HTTP adapter over the Control Service.

Properties:

- binds only `127.0.0.1`;
- health endpoint;
- durable run-state endpoint;
- autonomous-start capability endpoint;
- autonomous-start JSON endpoint;
- unsafe/in-flight parent remains fail-closed;
- duplicate request remains no-replay;
- no Mission launcher or process-spawn primitive exists in the server.

Next boundary: thin GUI client over this transport.
