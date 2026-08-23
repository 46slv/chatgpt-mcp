const byId = id =>
  document.getElementById(id);

const serverStatus =
  byId("server-status");

const parentRun =
  byId("parent-run");

const inspectRun =
  byId("inspect-run");

const inspectCapability =
  byId("inspect-capability");

const startRun =
  byId("start-run");

const phase =
  byId("phase");

const canStart =
  byId("can-start");

const pending =
  byId("pending");

const ambiguous =
  byId("ambiguous");

const inspectionOutput =
  byId("inspection-output");

const launchOutput =
  byId("launch-output");

const missionId =
  byId("mission-id");

const childRun =
  byId("child-run");

const goal =
  byId("goal");

const entryPath =
  byId("entry-path");

const targetAlias =
  byId("target-alias");

const constraints =
  byId("constraints");

let capability = null;

function pretty(value) {
  return JSON.stringify(
    value,
    null,
    2,
  );
}

async function requestJson(
  url,
  options = {},
) {
  const response =
    await fetch(
      url,
      {
        cache: "no-store",
        ...options,
      },
    );

  const body =
    await response.json();

  if (!response.ok) {
    const error =
      new Error(
        body?.error ??
        `HTTP_${response.status}`
      );

    error.status =
      response.status;

    error.body =
      body;

    throw error;
  }

  return body;
}

function parentId() {
  const value =
    parentRun.value.trim();

  if (!value) {
    throw new Error(
      "Parent run ID is required."
    );
  }

  return value;
}

function updateCapability(
  value,
) {
  capability = value;

  phase.textContent =
    value?.phase ?? "-";

  canStart.textContent =
    value?.can_start === true
      ? "YES"
      : "NO";

  canStart.className =
    value?.can_start === true
      ? "ok"
      : "blocked";

  pending.textContent =
    String(
      value?.boundary
        ?.pending_action ??
      "-"
    );

  ambiguous.textContent =
    String(
      value?.boundary
        ?.ambiguous_action ??
      "-"
    );

  startRun.disabled =
    value?.can_start !== true;
}

async function health() {
  try {
    const result =
      await requestJson(
        "/health"
      );

    serverStatus.className =
      "status ok";

    serverStatus
      .querySelector(
        "span:last-child"
      )
      .textContent =
        result.status === "ok"
          ? "Server online"
          : "Server response";
  } catch {
    serverStatus.className =
      "status error";

    serverStatus
      .querySelector(
        "span:last-child"
      )
      .textContent =
        "Server unavailable";
  }
}

async function loadRun() {
  try {
    const id =
      parentId();

    const result =
      await requestJson(
        `/v1/runs/${encodeURIComponent(id)}`
      );

    phase.textContent =
      result.state?.phase ??
      "-";

    inspectionOutput.textContent =
      pretty(result);
  } catch (error) {
    inspectionOutput.textContent =
      pretty(
        error.body ?? {
          error:
            error.message,
        },
      );
  }
}

async function loadCapability() {
  try {
    const id =
      parentId();

    const result =
      await requestJson(
        "/v1/autonomous-start/capability" +
        `?parent_run_id=${encodeURIComponent(id)}`
      );

    updateCapability(
      result,
    );

    inspectionOutput.textContent =
      pretty(result);
  } catch (error) {
    capability = null;

    startRun.disabled =
      true;

    canStart.textContent =
      "-";

    canStart.className =
      "";

    inspectionOutput.textContent =
      pretty(
        error.body ?? {
          error:
            error.message,
        },
      );
  }
}

function constraintList() {
  return constraints.value
    .split("|")
    .map(
      value =>
        value.trim()
    )
    .filter(Boolean);
}

function requiredInput(
  element,
  name,
) {
  const value =
    element.value.trim();

  if (!value) {
    throw new Error(
      `${name} is required.`
    );
  }

  return value;
}

async function launch() {
  startRun.disabled =
    true;

  try {
    if (
      capability?.can_start !==
      true
    ) {
      throw new Error(
        "Capability check does not permit launch."
      );
    }

    const body = {
      mission_id:
        requiredInput(
          missionId,
          "Mission ID",
        ),

      parent_run_id:
        parentId(),

      child_run_id:
        requiredInput(
          childRun,
          "Child run ID",
        ),

      goal:
        requiredInput(
          goal,
          "Goal",
        ),

      entry_path:
        requiredInput(
          entryPath,
          "Entry path",
        ),
    };

    const alias =
      targetAlias.value.trim();

    if (alias) {
      body.target_alias =
        alias;
    }

    const list =
      constraintList();

    if (list.length > 0) {
      body.constraints =
        list;
    }

    const result =
      await requestJson(
        "/v1/autonomous-start",
        {
          method:
            "POST",

          headers: {
            "content-type":
              "application/json",
          },

          body:
            JSON.stringify(
              body
            ),
        },
      );

    launchOutput.textContent =
      pretty(result);

    await loadCapability();
  } catch (error) {
    launchOutput.textContent =
      pretty(
        error.body ?? {
          error:
            error.message,
        },
      );
  } finally {
    startRun.disabled =
      capability?.can_start !==
      true;
  }
}

inspectRun.addEventListener(
  "click",
  loadRun,
);

inspectCapability.addEventListener(
  "click",
  loadCapability,
);

startRun.addEventListener(
  "click",
  launch,
);

parentRun.addEventListener(
  "input",
  () => {
    capability = null;

    startRun.disabled =
      true;

    canStart.textContent =
      "-";

    canStart.className =
      "";
  },
);

await health();
