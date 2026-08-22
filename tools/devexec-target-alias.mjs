export function parseInheritedTargetAlias(value) {
  if (value == null) return null;
  if (typeof value !== "string") throw new Error("DEV_EXEC_TARGET_ALIAS_INVALID");
  return value.trim() || null;
}

export function normalizeDurableTargetAlias(value) {
  if (value == null) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("MISSION_LAUNCH_TARGET_ALIAS_INVALID");
  }
  return value.trim();
}

export function applyTargetAliasToEnv(env, targetAlias) {
  const result = {...env};
  const normalized = targetAlias == null ? null : normalizeDurableTargetAlias(targetAlias);
  if (normalized) result.DEV_EXEC_TARGET_ALIAS = normalized;
  else delete result.DEV_EXEC_TARGET_ALIAS;
  return result;
}
