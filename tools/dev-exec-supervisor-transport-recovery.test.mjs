import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  classifyPersistedSupervisorInflight,
  classifySupervisorTransportError,
} from "./dev-exec-supervisor-transport-recovery.mjs";

test(
  "persisted READINESS_CHECK IN_FLIGHT is retryable",
  () => {
    assert.equal(
      classifyPersistedSupervisorInflight({
        send_state: "IN_FLIGHT",
        transport_phase: "READINESS_CHECK",
      }).retryable,
      true,
    );
  },
);

test(
  "persisted post-submit states fail closed",
  () => {
    for (const phase of [
      "SUBMITTING",
      "WAITING_RESPONSE",
      "COMPLETED",
      "UNKNOWN",
      "STATE_UNREADABLE",
    ]) {
      assert.equal(
        classifyPersistedSupervisorInflight({
          send_state: "IN_FLIGHT",
          transport_phase: phase,
        }).retryable,
        false,
        phase,
      );
    }
  },
);

test(
  "composer readiness failure is retryable only pre-submit",
  () => {
    assert.equal(
      classifySupervisorTransportError({
        transport_phase: "READINESS_CHECK",
        error_message:
          "ChatGPT composer did not become operational.",
      }).retryable,
      true,
    );

    assert.equal(
      classifySupervisorTransportError({
        transport_phase: "SUBMITTING",
        error_message:
          "ChatGPT composer did not become operational.",
      }).retryable,
      false,
    );
  },
);

test(
  "unrelated readiness error is not automatically retryable",
  () => {
    assert.equal(
      classifySupervisorTransportError({
        transport_phase: "READINESS_CHECK",
        error_message: "Unexpected transport failure",
      }).retryable,
      false,
    );
  },
);

test(
  "completed local execution is never rewound",
  () => {
    const source =
      fs.readFileSync(
        new URL(
          "./dev-exec-loop.mjs",
          import.meta.url
        ),
        "utf8",
      );

    assert.match(
      source,
      /PRE_SUBMIT_IN_FLIGHT_RECOVERED/
    );

    assert.match(
      source,
      /RETRYABLE_TRANSPORT_FAILURE/
    );

    assert.match(
      source,
      /PRE_SUBMIT_RETRY_EXHAUSTED/
    );

    assert.match(
      source,
      /local_exec_replay=NO/
    );

    assert.doesNotMatch(
      source,
      /state\.step\s*-=/,
    );
  },
);