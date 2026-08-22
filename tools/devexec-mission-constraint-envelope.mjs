function required(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} required`);
  return value.trim();
}

export function normalizeMissionConstraints(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("MISSION_CONSTRAINTS_ARRAY_REQUIRED");
  return value.map((item, index) => required(item, `mission_constraints[${index}]`));
}

export function parseMissionConstraintsEnv(raw) {
  if (raw == null || raw === "") return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const wrapped = new Error("MISSION_CONSTRAINTS_JSON_INVALID");
    wrapped.cause = error;
    throw wrapped;
  }
  return normalizeMissionConstraints(parsed);
}

export function renderMissionGoalWithConstraints(goal, constraints = []) {
  const baseGoal = required(goal, "goal");
  const normalized = normalizeMissionConstraints(constraints);
  if (!normalized.length) return baseGoal;
  return [
    baseGoal,
    "",
    "DEV EXEC MISSION CONSTRAINTS — apply all of these to this continuation:",
    ...normalized.map((constraint, index) => `${index + 1}. ${constraint}`),
  ].join("\n");
}
