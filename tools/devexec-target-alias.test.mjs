import assert from "node:assert/strict";
import test from "node:test";

import {
  applyTargetAliasToEnv,
  normalizeDurableTargetAlias,
  parseInheritedTargetAlias,
} from "./devexec-target-alias.mjs";

test("inherited target alias treats blank transport as no target", () => {
  assert.equal(parseInheritedTargetAlias(undefined), null);
  assert.equal(parseInheritedTargetAlias(""), null);
  assert.equal(parseInheritedTargetAlias("   "), null);
  assert.equal(parseInheritedTargetAlias("  child-target  "), "child-target");
  assert.throws(() => parseInheritedTargetAlias({bad: true}), /DEV_EXEC_TARGET_ALIAS_INVALID/);
});

test("durable target alias requires a non-blank string and canonicalizes whitespace", () => {
  assert.equal(normalizeDurableTargetAlias(null), null);
  assert.equal(normalizeDurableTargetAlias("  child-target  "), "child-target");
  assert.throws(() => normalizeDurableTargetAlias("   "), /MISSION_LAUNCH_TARGET_ALIAS_INVALID/);
  assert.throws(() => normalizeDurableTargetAlias({bad: true}), /MISSION_LAUNCH_TARGET_ALIAS_INVALID/);
});

test("target env application clears stale inherited alias when no target is selected", () => {
  assert.deepEqual(
    applyTargetAliasToEnv({DEV_EXEC_TARGET_ALIAS: "parent-target", KEEP_ME: "yes"}, null),
    {KEEP_ME: "yes"},
  );
  assert.deepEqual(
    applyTargetAliasToEnv({DEV_EXEC_TARGET_ALIAS: "parent-target", KEEP_ME: "yes"}, " child-target "),
    {DEV_EXEC_TARGET_ALIAS: "child-target", KEEP_ME: "yes"},
  );
});
