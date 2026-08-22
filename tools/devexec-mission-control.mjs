import fs from "node:fs";

import {withMissionLock} from "./devexec-mission-lock.mjs";
import {
  attachMissionRun,
  createMissionState,
  loadMissionState,
  resolveMissionPaths,
  saveMissionState,
} from "./devexec-mission-state.mjs";
import {
  beginAmendmentApply,
  carryAmendmentsToRun,
  completeAmendmentApply,
  createAmendmentQueue,
  enqueueAmendment,
  loadAmendmentQueue,
  saveAmendmentQueue,
  selectApplicableAmendments,
} from "./devexec-mission-amendments.mjs";

function assertMissionMatch(state, queue) {
  if (state.mission_id !== queue.mission_id) throw new Error("MISSION_QUEUE_ID_MISMATCH");
}

function findRun(state, runId) {
  return state.runs.find(run => run.run_id === runId) ?? null;
}

function refreshBoundControl(control) {
  const state = loadMissionState(control.paths.state_file);
  if (state.mission_id !== control.state.mission_id) throw new Error("MISSION_STATE_ID_MISMATCH");
  const boundRunId = control.bound_run_id ?? control.state.current_run_id;
  if (state.current_run_id !== boundRunId) throw new Error("STALE_MISSION_CONTROL");
  const amendments = loadAmendmentQueue(control.paths.amendments_file);
  assertMissionMatch(state, amendments);
  if (amendments.current_run_id !== boundRunId) throw new Error("MISSION_QUEUE_RUN_MISMATCH");
  control.state = state;
  control.amendments = amendments;
  return control;
}

export function openMissionControl({base, mission_id, run_id, parent_run_id = null, now = new Date().toISOString()} = {}) {
  const paths = resolveMissionPaths(base, mission_id);
  return withMissionLock(paths.root, () => {
    let state;
    let created = false;

    if (!fs.existsSync(paths.state_file)) {
      if (parent_run_id !== null) throw new Error("MISSION_ROOT_REQUIRED_BEFORE_CHILD");
      state = createMissionState({mission_id, root_run_id: run_id, now});
      saveMissionState(paths.state_file, state);
      created = true;
    } else {
      state = loadMissionState(paths.state_file);
      if (state.mission_id !== mission_id) throw new Error("MISSION_STATE_ID_MISMATCH");
      const existing = findRun(state, run_id);
      if (existing) {
        if (state.current_run_id !== run_id) throw new Error("STALE_RUN_ID");
        if (parent_run_id !== null && existing.parent_run_id !== parent_run_id) throw new Error("RUN_LINEAGE_CONFLICT");
      } else {
        if (parent_run_id === null) throw new Error("parent_run_id required for child run");
        if (parent_run_id !== state.current_run_id) throw new Error("STALE_PARENT_RUN_ID");
        attachMissionRun(state, {run_id, parent_run_id, now});
        saveMissionState(paths.state_file, state);
      }
    }

    let amendments;
    if (fs.existsSync(paths.amendments_file)) {
      amendments = loadAmendmentQueue(paths.amendments_file);
    } else {
      amendments = createAmendmentQueue({mission_id, run_id});
      saveAmendmentQueue(paths.amendments_file, amendments);
    }
    assertMissionMatch(state, amendments);

    if (amendments.current_run_id !== run_id) {
      carryAmendmentsToRun(amendments, run_id);
      saveAmendmentQueue(paths.amendments_file, amendments);
    }

    return {paths, state, amendments, created, bound_run_id: run_id};
  });
}

export function enqueueMissionAmendment(control, input, options = {}) {
  return withMissionLock(control.paths.root, () => {
    refreshBoundControl(control);
    const result = enqueueAmendment(control.amendments, input, options);
    if (!result.deduplicated) saveAmendmentQueue(control.paths.amendments_file, control.amendments);
    return result;
  });
}

export function listApplicableMissionAmendments(control, boundary = {}) {
  return withMissionLock(control.paths.root, () => {
    refreshBoundControl(control);
    return selectApplicableAmendments(control.amendments, {
      ...boundary,
      run_id: control.state.current_run_id,
    });
  });
}

export function beginMissionAmendmentApply(control, amendmentId, boundary = {}, options = {}) {
  return withMissionLock(control.paths.root, () => {
    refreshBoundControl(control);
    const result = beginAmendmentApply(
      control.amendments,
      amendmentId,
      {...boundary, run_id: control.state.current_run_id},
      options,
    );
    if (!result.deduplicated) saveAmendmentQueue(control.paths.amendments_file, control.amendments);
    return result;
  });
}

export function completeMissionAmendmentApply(control, amendmentId, options = {}) {
  return withMissionLock(control.paths.root, () => {
    refreshBoundControl(control);
    const result = completeAmendmentApply(control.amendments, amendmentId, options);
    if (!result.deduplicated) saveAmendmentQueue(control.paths.amendments_file, control.amendments);
    return result;
  });
}
