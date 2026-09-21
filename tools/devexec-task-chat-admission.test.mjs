import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  TASK_CHAT_ADMISSION_ERRORS,
  TASK_CHAT_ADMISSION_PHASES,
  admitTaskChat,
  buildTaskChatAdmissionSeed,
  computeTaskChatAdmissionId,
  taskChatAdmissionPath,
  taskChatAdmissionSeedHash,
  taskChatAdmissionStatus,
} from "./devexec-task-chat-admission.mjs";
import { createTaskChatBinding, validateTaskChatBinding } from "./devexec-task-chat-binding.mjs";

function root(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `task-chat-admission-${label}-`));
}

function ack(chat = "chat-a", at = "2026-09-22T01:00:00.000Z") {
  return {
    chat_url: `https://chatgpt.com/c/${chat}`,
    conversation_id: chat,
    acknowledgement: {
      status: "USER_TURN_ACK",
      user_turn_seq: 1,
      user_turn_index: 0,
      ack_turn_count: 1,
      user_turn_text: "[TASK_CHAT_ADMISSION]",
      acked_at: at,
    },
  };
}

function options(admissionRoot, overrides = {}) {
  return {
    mission_id: "mission-admission-test",
    task_id: "task-a",
    admission_root: admissionRoot,
    prepare: async () => ({ prepared: true }),
    send: async () => ack(),
    now: () => "2026-09-22T01:00:00.000Z",
    ...overrides,
  };
}

test("admission identity and bounded seed are deterministic from mission + task", () => {
  const admissionId = computeTaskChatAdmissionId("mission-1", "task-1");
  assert.match(admissionId, /^admit-[a-f0-9]{64}$/);
  assert.equal(admissionId, computeTaskChatAdmissionId("mission-1", "task-1"));
  assert.notEqual(admissionId, computeTaskChatAdmissionId("mission-1", "task-2"));
  const seed = buildTaskChatAdmissionSeed({ mission_id: "mission-1", task_id: "task-1", admission_id: admissionId });
  assert.match(seed, /^\[TASK_CHAT_ADMISSION\]\[admit-[a-f0-9]{64}\]/);
  assert.equal(taskChatAdmissionSeedHash(seed), `sha256:${crypto.createHash("sha256").update(seed).digest("hex")}`);
  assert.equal(seed.includes("password"), false);
});

test("same Task replay returns one immutable binding and sends exactly once", async () => {
  const admissionRoot = root("replay");
  let sends = 0;
  const input = options(admissionRoot, { send: async () => { sends += 1; return ack(); } });
  const first = await admitTaskChat(input);
  const second = await admitTaskChat({ ...input, prepare: async () => { throw new Error("replay must not prepare"); }, send: async () => { sends += 1; throw new Error("replay must not send"); } });
  assert.equal(first.state.phase, TASK_CHAT_ADMISSION_PHASES.BOUND);
  assert.equal(second.state.phase, TASK_CHAT_ADMISSION_PHASES.BOUND);
  assert.equal(first.binding.binding_id, second.binding.binding_id);
  assert.equal(first.binding.conversation_id, second.binding.conversation_id);
  assert.equal(second.seed_sent, false);
  assert.equal(sends, 1);
  assert.deepEqual(validateTaskChatBinding(first.binding), first.binding);
});

test("different Task identity receives a different admission and conversation", async () => {
  const admissionRoot = root("different-task");
  let taskCounter = 0;
  const first = await admitTaskChat(options(admissionRoot, { send: async () => ack("chat-a") }));
  const second = await admitTaskChat(options(admissionRoot, { task_id: "task-b", send: async () => { taskCounter += 1; return ack("chat-b"); } }));
  assert.notEqual(first.admission_id, second.admission_id);
  assert.notEqual(first.binding.conversation_id, second.binding.conversation_id);
  assert.equal(taskCounter, 1);
  assert.notEqual(first.binding.binding_id, second.binding.binding_id);
});

test("canonical URL and conversation id are validated by existing TaskChatBinding parser", async () => {
  const admissionRoot = root("canonical");
  const result = await admitTaskChat(options(admissionRoot, { send: async () => ack("chat-canonical") }));
  assert.equal(result.binding.chat_url, "https://chatgpt.com/c/chat-canonical");
  assert.equal(result.binding.conversation_id, "chat-canonical");
  assert.deepEqual(validateTaskChatBinding(result.binding), result.binding);
  await assert.rejects(() => admitTaskChat(options(root("bad-url"), { send: async () => ({ ...ack("chat-bad"), conversation_id: "different" }) })), (error) => error.code === TASK_CHAT_ADMISSION_ERRORS.UNKNOWN);
});

test("same-Task concurrent callers serialize and cannot create two conversations", async () => {
  const admissionRoot = root("concurrent");
  let sends = 0;
  let prepares = 0;
  const input = options(admissionRoot, {
    prepare: async () => { prepares += 1; await new Promise((resolve) => setTimeout(resolve, 100)); },
    send: async () => { sends += 1; await new Promise((resolve) => setTimeout(resolve, 100)); return ack("chat-concurrent"); },
  });
  const [first, second] = await Promise.all([admitTaskChat(input), admitTaskChat(input)]);
  assert.equal(sends, 1);
  assert.equal(prepares, 1);
  assert.equal(first.binding.binding_id, second.binding.binding_id);
  assert.equal(first.state.phase, TASK_CHAT_ADMISSION_PHASES.BOUND);
});

test("pre-send preparation failure is retryable as FAILED_PRE_SEND", async () => {
  const admissionRoot = root("pre-send");
  let shouldFail = true;
  let sends = 0;
  const input = options(admissionRoot, {
    prepare: async () => { if (shouldFail) throw new Error("browser unavailable before send"); },
    send: async () => { sends += 1; return ack("chat-retry"); },
  });
  await assert.rejects(() => admitTaskChat(input), (error) => error.code === TASK_CHAT_ADMISSION_ERRORS.FAILED_PRE_SEND);
  assert.equal(taskChatAdmissionStatus({ mission_id: input.mission_id, task_id: input.task_id, admission_root: admissionRoot }).phase, TASK_CHAT_ADMISSION_PHASES.FAILED_PRE_SEND);
  shouldFail = false;
  const recovered = await admitTaskChat(input);
  assert.equal(recovered.state.phase, TASK_CHAT_ADMISSION_PHASES.BOUND);
  assert.equal(sends, 1);
});

test("failure after SEND_INTENT becomes ADMISSION_UNKNOWN and replay never sends blindly", async () => {
  const admissionRoot = root("unknown");
  let sends = 0;
  const input = options(admissionRoot, {
    send: async () => { sends += 1; throw new Error("connection dropped after browser submit"); },
  });
  await assert.rejects(() => admitTaskChat(input), (error) => error.code === TASK_CHAT_ADMISSION_ERRORS.UNKNOWN);
  const status = taskChatAdmissionStatus({ mission_id: input.mission_id, task_id: input.task_id, admission_root: admissionRoot });
  assert.equal(status.phase, TASK_CHAT_ADMISSION_PHASES.ADMISSION_UNKNOWN);
  await assert.rejects(() => admitTaskChat({ ...input, send: async () => { sends += 1; return ack("chat-never"); } }), (error) => error.code === TASK_CHAT_ADMISSION_ERRORS.UNKNOWN);
  assert.equal(sends, 1);
});

test("durable ACKED state completes to BOUND after restart without another send", async () => {
  const admissionRoot = root("acked-restart");
  const input = options(admissionRoot, { send: async () => ack("chat-acked") });
  const first = await admitTaskChat(input);
  const file = taskChatAdmissionPath(input.mission_id, input.task_id, { admissionRoot });
  const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
  persisted.phase = TASK_CHAT_ADMISSION_PHASES.ACKED;
  persisted.binding = null;
  fs.writeFileSync(file, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
  let sends = 0;
  const recovered = await admitTaskChat({ ...input, prepare: async () => { throw new Error("ACKED recovery must not prepare"); }, send: async () => { sends += 1; return ack("chat-other"); } });
  assert.equal(recovered.state.phase, TASK_CHAT_ADMISSION_PHASES.BOUND);
  assert.equal(recovered.binding.conversation_id, first.binding.conversation_id);
  assert.equal(sends, 0);
});

test("status is read-only and absent does not consult browser or target registry", () => {
  const admissionRoot = root("status");
  const status = taskChatAdmissionStatus({ mission_id: "mission-status", task_id: "task-status", admission_root: admissionRoot });
  assert.equal(status.phase, TASK_CHAT_ADMISSION_PHASES.ABSENT);
  assert.equal(status.binding, null);
  assert.equal(status.file, taskChatAdmissionPath("mission-status", "task-status", { admissionRoot }));
});

test("restart can reclaim a lock from a crashed owner and complete durable ACKED", async () => {
  const admissionRoot = root("dead-lock");
  const input = options(admissionRoot, { send: async () => ack("chat-dead-lock") });
  const first = await admitTaskChat(input);
  const file = taskChatAdmissionPath(input.mission_id, input.task_id, { admissionRoot });
  const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
  persisted.phase = TASK_CHAT_ADMISSION_PHASES.ACKED;
  persisted.binding = null;
  fs.writeFileSync(file, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
  const lock = `${file}.lock`;
  fs.writeFileSync(lock, "2147483647\n", "utf8");
  const recovered = await admitTaskChat({ ...input, prepare: async () => { throw new Error("must not prepare after ACKED"); }, send: async () => { throw new Error("must not send after ACKED"); } });
  assert.equal(recovered.binding.binding_id, first.binding.binding_id);
  assert.equal(fs.existsSync(lock), false);
});
