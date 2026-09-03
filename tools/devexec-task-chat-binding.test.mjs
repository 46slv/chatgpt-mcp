import assert from "node:assert/strict";
import test from "node:test";

import {
  TASK_CHAT_BINDING_ERRORS,
  bindTaskChatTarget,
  createTaskChatRelayReport,
  createTaskChatBinding,
  getTaskChatReturnTarget,
  validateTaskChatBinding,
  validateTaskChatRelayReport,
} from "./devexec-task-chat-binding.mjs";
import { emptyRegistry, resolveTarget, setTarget, useTarget } from "./target-registry.mjs";

const BOUND_AT = "2026-09-02T08:00:00.000Z";
const CHAT_A = "https://chatgpt.com/c/chat-a";
const CHAT_B = "https://chatgpt.com/c/chat-b";
const CHAT_X = "https://chatgpt.com/c/chat-x";

function admission({ mission_id = "mission-1", task_id = "task-a", chat_url = CHAT_A, source = "explicit-alias", source_alias = "task-a-alias" } = {}) {
  return createTaskChatBinding({ mission_id, task_id, chat_url, conversation_id: chat_url.split("/").at(-1), source, source_alias, bound_at: BOUND_AT });
}

function report(binding, extra = {}) {
  return createTaskChatRelayReport({ binding, completion: "completed", situation: "tests pass", ...extra });
}

test("Task A is bound to Chat A with an immutable parent-owned identity", () => {
  const binding = admission();
  assert.equal(binding.protocol, "devexec.task-chat-binding");
  assert.equal(binding.schema_version, 1);
  assert.equal(binding.mission_id, "mission-1");
  assert.equal(binding.task_id, "task-a");
  assert.equal(binding.chat_url, CHAT_A);
  assert.equal(binding.conversation_id, "chat-a");
  assert.equal(binding.source, "explicit-alias");
  assert.equal(binding.source_alias, "task-a-alias");
  assert.match(binding.binding_id, /^sha256:[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(binding), true);
  assert.deepEqual(getTaskChatReturnTarget(binding), { binding_id: binding.binding_id, chat_url: CHAT_A, conversation_id: "chat-a" });
});

test("a wrong fixture default target cannot replace Task A's explicit admission target", () => {
  const registry = emptyRegistry();
  setTarget(registry, "task-a-alias", CHAT_A);
  setTarget(registry, "old-default", CHAT_X);
  useTarget(registry, "old-default");

  const resolvedAtAdmission = resolveTarget({ explicitTarget: "task-a-alias", registry });
  const binding = createTaskChatBinding({
    mission_id: "mission-1",
    task_id: "task-a",
    target: resolvedAtAdmission,
    bound_at: BOUND_AT,
  });

  assert.equal(binding.chat_url, CHAT_A);
  assert.equal(validateTaskChatRelayReport(report(binding), binding).return_target.chat_url, CHAT_A);
});

test("changing the registry default after admission does not change Task A", () => {
  const registry = emptyRegistry();
  setTarget(registry, "task-a-alias", CHAT_A);
  setTarget(registry, "new-default", CHAT_B);
  useTarget(registry, "task-a-alias");
  const binding = createTaskChatBinding({ mission_id: "mission-1", task_id: "task-a", target: resolveTarget({ registry }), bound_at: BOUND_AT });

  useTarget(registry, "new-default");
  assert.equal(validateTaskChatRelayReport(report(binding), binding).return_target.chat_url, CHAT_A);
  assert.equal(binding.chat_url, CHAT_A);
});

test("remapping the admission alias after binding does not change Task A", () => {
  const registry = emptyRegistry();
  setTarget(registry, "task-a-alias", CHAT_A);
  const binding = createTaskChatBinding({ mission_id: "mission-1", task_id: "task-a", target: resolveTarget({ explicitTarget: "task-a-alias", registry }), bound_at: BOUND_AT });

  setTarget(registry, "task-a-alias", CHAT_B);
  assert.equal(validateTaskChatRelayReport(report(binding), binding).return_target.chat_url, CHAT_A);
});

test("missing binding fails closed without consulting defaults or legacy environment", () => {
  const previous = process.env.CHATGPT_MCP_CHAT_URL;
  process.env.CHATGPT_MCP_CHAT_URL = CHAT_X;
  try {
    assert.throws(
      () => validateTaskChatRelayReport({ protocol: "devexec.codex-relay-report", schema_version: 1, task_id: "task-a", return_target: getTaskChatReturnTarget(admission()) }, null),
      (error) => error.code === TASK_CHAT_BINDING_ERRORS.REQUIRED,
    );
  } finally {
    if (previous === undefined) delete process.env.CHATGPT_MCP_CHAT_URL;
    else process.env.CHATGPT_MCP_CHAT_URL = previous;
  }
});

test("a relay report with the wrong binding ID fails closed", () => {
  const binding = admission();
  const invalid = { ...report(binding), return_target: { ...report(binding).return_target, binding_id: admission({ task_id: "other-task" }).binding_id } };
  assert.throws(() => validateTaskChatRelayReport(invalid, binding), (error) => error.code === TASK_CHAT_BINDING_ERRORS.MISMATCH);
});

test("a relay report with the wrong URL or conversation ID fails closed", () => {
  const binding = admission();
  const wrongUrl = { ...report(binding), return_target: { ...report(binding).return_target, chat_url: CHAT_B } };
  assert.throws(() => validateTaskChatRelayReport(wrongUrl, binding), (error) => error.code === TASK_CHAT_BINDING_ERRORS.MISMATCH);

  const wrongConversation = { ...report(binding), return_target: { ...report(binding).return_target, conversation_id: "chat-b" } };
  assert.throws(() => validateTaskChatRelayReport(wrongConversation, binding), (error) => error.code === TASK_CHAT_BINDING_ERRORS.MISMATCH);
});

test("Task A and Task B cannot cross-route", () => {
  const taskA = admission({ task_id: "task-a", chat_url: CHAT_A, source_alias: "alias-a" });
  const taskB = admission({ task_id: "task-b", chat_url: CHAT_B, source_alias: "alias-b" });

  const crossTarget = { ...report(taskB), task_id: taskA.task_id };
  assert.throws(() => validateTaskChatRelayReport(crossTarget, taskA), (error) => error.code === TASK_CHAT_BINDING_ERRORS.MISMATCH);

  const crossTask = { ...report(taskA), task_id: taskB.task_id };
  assert.throws(() => validateTaskChatRelayReport(crossTask, taskA), (error) => error.code === TASK_CHAT_BINDING_ERRORS.TASK_MISMATCH);
});

test("binding hash is deterministic for canonical equivalent input", () => {
  const first = bindTaskChatTarget({
    mission_id: "mission-1",
    task_id: "task-a",
    target: { chat_url: CHAT_A, conversation_id: "chat-a", source: "explicit-alias", target_id: "alias-a" },
    bound_at: BOUND_AT,
  });
  const second = createTaskChatBinding({
    bound_at: BOUND_AT,
    source_alias: "alias-a",
    source: "explicit-alias",
    conversation_id: "chat-a",
    chat_url: CHAT_A,
    task_id: "task-a",
    mission_id: "mission-1",
  });
  assert.equal(first.binding_id, second.binding_id);
  assert.deepEqual(validateTaskChatBinding(first), validateTaskChatBinding(second));
});

test("semantic binding changes produce a different hash", () => {
  const original = admission();
  assert.notEqual(original.binding_id, admission({ task_id: "task-b" }).binding_id);
  assert.notEqual(original.binding_id, admission({ chat_url: CHAT_B }).binding_id);
  assert.notEqual(original.binding_id, admission({ source: "explicit-url" }).binding_id);
  assert.notEqual(original.binding_id, admission({ mission_id: "mission-2" }).binding_id);
});
