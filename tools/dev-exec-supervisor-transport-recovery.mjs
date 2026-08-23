export function classifyPersistedSupervisorInflight({
  send_state,
  transport_phase,
} = {}) {
  if (
    send_state === "IN_FLIGHT" &&
    transport_phase === "READINESS_CHECK"
  ) {
    return {
      retryable: true,
      reason: "PROVEN_PRE_SUBMIT_IN_FLIGHT",
    };
  }

  return {
    retryable: false,
    reason: "AMBIGUOUS_OR_POST_SUBMIT",
  };
}

export function classifySupervisorTransportError({
  transport_phase,
  error_message = "",
} = {}) {
  const message = String(error_message ?? "");

  if (
    transport_phase === "READINESS_CHECK" &&
    /composer did not become operational/i.test(message)
  ) {
    return {
      retryable: true,
      reason: "COMPOSER_NOT_OPERATIONAL_PRE_SUBMIT",
    };
  }

  return {
    retryable: false,
    reason: "AMBIGUOUS_OR_POST_SUBMIT",
  };
}