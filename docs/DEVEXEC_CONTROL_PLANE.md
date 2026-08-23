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

## Thin local GUI

The GUI is served from the same loopback Control Server origin.

It uses only HTTP for health, durable run-state inspection, autonomous-start
capability inspection, and autonomous child-run submission.

The GUI contains no Mission persistence access, safety derivation, Mission
launch primitive, or process-spawn implementation.

Authority chain:

Mission primitives -> typed autonomous start -> Control Service -> loopback
Control Server -> GUI.

## Production lifecycle

`devexec control` manages only the dedicated loopback Control Server process.

Commands:

- `devexec control start`
- `devexec control start --open`
- `devexec control status`
- `devexec control stop`
- `devexec control open`

The lifecycle layer may start/terminate the Control Server and open its GUI URL.
It contains no Mission launch primitive.

Authority remains:

Mission primitives -> typed autonomous start -> Control Service -> loopback
Control Server -> GUI/lifecycle.

## Windows user launcher

DEV-005 adds user-level installation/update packaging for the local control
surface.

`tools/install-devexec-control.ps1` creates:

- a `DevExec Control.cmd` launcher for `devexec control start --open`;
- status and stop launchers;
- a user-level Start Menu shortcut;
- an installation manifest recording the repository and Node paths.

The installer delegates only to the production lifecycle CLI. It contains no
Mission launch authority.

Lifecycle stale-receipt behavior is covered separately: a receipt whose PID is
no longer alive is classified as stale and can be cleared without signaling an
unrelated process.

Real user installation is performed only after the published installer bytes
are validated.

## Thin GUI Operational UX

DEV-005 improves the existing thin browser client without extending authority.

The GUI presents loopback connection detail, server availability, actionable
operation errors, Start Menu recovery guidance, and Control Doctor guidance.

Errors from durable run-state reads, capability checks, and child-run requests
are surfaced visibly while their structured response remains available in the
existing output panels.

All browser behavior remains same-origin HTTP against the loopback Control
Server. Browser code contains no process management and no Mission launch
authority.
