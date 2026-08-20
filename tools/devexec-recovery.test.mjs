import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyRunState, loadAndClassifyRunState } from "./devexec-recovery.mjs";

const terminal = classifyRunState({ run_id: "A", phase: "COMPLETE", step: 4, pending: null, rounds: {} });
assert.equal(terminal.classification, "TERMINAL");
assert.equal(terminal.safe_to_continue, true);
assert.equal(terminal.recommended_action, "continue");

const execAmbiguous = classifyRunState({ run_id: "B", phase: "EXEC_IN_FLIGHT", step: 4, pending: { step: 5 }, rounds: {} });
assert.equal(execAmbiguous.classification, "AMBIGUOUS_EXEC_IN_FLIGHT");
assert.equal(execAmbiguous.safe_to_continue, false);
assert.equal(execAmbiguous.pending_step, 5);

const supervisorAmbiguous = classifyRunState({ run_id: "C", phase: "SUPERVISOR_ROUND_6_IN_FLIGHT", step: 5, pending: null, rounds: { "6": { send_state: "IN_FLIGHT" } } });
assert.equal(supervisorAmbiguous.classification, "AMBIGUOUS_SUPERVISOR_IN_FLIGHT");
assert.equal(supervisorAmbiguous.safe_to_continue, false);
assert.equal(supervisorAmbiguous.supervisor_round, 6);

const nonterminal = classifyRunState({ run_id: "D", phase: "STEP_PASS", step: 2, pending: null, rounds: {} });
assert.equal(nonterminal.classification, "NONTERMINAL");
assert.equal(nonterminal.safe_to_continue, false);
assert.equal(nonterminal.recommended_action, "resume-existing-run");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devexec-recovery-test-"));
fs.writeFileSync(path.join(dir, "E.json"), JSON.stringify({ run_id: "E", phase: "FAILED", step: 8, pending: null, rounds: {} }), "utf8");
const loaded = loadAndClassifyRunState(dir, "E");
assert.equal(loaded.classification, "TERMINAL");
assert.equal(loaded.phase, "FAILED");

console.log("DEVEXEC_RECOVERY_CLASSIFIER_TEST_PASS");
