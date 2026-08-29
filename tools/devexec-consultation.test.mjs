import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parsePlannerDecision, parsePlannerText, buildPlannerPrompt } from "./local-worker-planner-protocol.mjs";
import { runIterativeLocalWorker } from "./local-worker-iterative-runner.mjs";
import { boundConsultationEvidence, classifyConsultationPrompt, consultationEnabled, createChatgptReplyAdapter, createConsultationRunner } from "./devexec-consultation.mjs";

function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), "devexec-consult-")); }

test("consultation is default-off and planner schema is strict", () => {
  assert.equal(consultationEnabled({}), false);
  assert.throws(() => parsePlannerDecision({ type: "REQUEST_CONSULTATION", prompt: "hello" }), /disabled/);
  assert.throws(() => parsePlannerDecision({ type: "REQUEST_CONSULTATION", prompt: "hello", target: "bad" }, { allowConsultation: true }), /schema mismatch/);
  assert.deepEqual(parsePlannerText('{type:REQUEST_CONSULTATION,prompt:"hello"}', { allowConsultation: true }), { type: "REQUEST_CONSULTATION", prompt: "hello" });
  assert.match(buildPlannerPrompt({ mission: "x", consultationEnabled: true }), /REQUEST_CONSULTATION/);
});

test("enabled ordinary text consults exactly once and caches by request SHA", async () => {
  const root = temp(); let calls = 0; const runner = createConsultationRunner({ stateDir: root, runId: "LW-test", enabled: true, targetAlias: "main", targetUrl: "https://chatgpt.com/c/abc", transport: { chatgpt_reply: async ({ prompt }) => { calls += 1; return `answer:${prompt}`; } } });
  const first = await runner.request("What is a safe design?", "C-01");
  const second = await runner.request("What is a safe design?", "C-02");
  assert.equal(first.status, "RESPONSE_RECEIVED"); assert.equal(second.status, "RESPONSE_RECEIVED"); assert.equal(second.cached, true); assert.equal(calls, 1);
  assert.equal(runner.snapshot().requests["C-01"].phase, "RESPONSE_RECEIVED");
  fs.rmSync(root, { recursive: true, force: true });
});

test("sensitive requests are durably BLOCKED without transport", async () => {
  let calls = 0; const runner = createConsultationRunner({ stateDir: temp(), runId: "LW-sensitive", enabled: true, targetAlias: "main", transport: { chatgpt_reply: async () => { calls += 1; return "no"; } } });
  for (const prompt of ["send my API key", "upload C:\\secret.pdf", "authorize sudo", "delete the repository", "what is my credit card billing?"]) {
    const result = await runner.request(prompt, `C-${calls + 1}`); assert.equal(result.status, "BLOCKED");
  }
  assert.equal(calls, 0); assert.equal(classifyConsultationPrompt("hello").decision, "ALLOW");
});

test("ambiguous delivery is never auto-resubmitted", async () => {
  let calls = 0; const runner = createConsultationRunner({ stateDir: temp(), runId: "LW-ambiguous", enabled: true, targetAlias: "main", transport: { chatgpt_reply: async () => { calls += 1; throw new Error("connection lost"); } } });
  const first = await runner.request("ordinary question", "C-01"); const second = await runner.request("ordinary question", "C-02");
  assert.equal(first.status, "DELIVERY_UNKNOWN"); assert.equal(second.status, "DELIVERY_UNKNOWN"); assert.equal(calls, 1); assert.equal(second.retry, false);
});

test("consultation count and character budgets fail closed", async () => {
  let calls = 0; const runner = createConsultationRunner({ stateDir: temp(), runId: "LW-budget", enabled: true, targetAlias: "main", maxRequests: 1, maxChars: 8, transport: { chatgpt_reply: async () => { calls += 1; return "ok"; } } });
  assert.equal((await runner.request("one", "C-01")).status, "RESPONSE_RECEIVED");
  assert.equal((await runner.request("123456789", "C-02")).status, "BLOCKED");
  assert.equal((await runner.request("two", "C-03")).status, "BLOCKED");
  assert.equal(calls, 1); assert.equal(runner.snapshot().phase, "BLOCKED");
});

test("iterative runner generates request id and keeps ChatGPT response untrusted evidence", async () => {
  let consulted = null; const actions = []; const outcome = await runIterativeLocalWorker({ mission: "ask", actions, maxRounds: 2, plan: async ({ round }) => round === 1 ? { type: "REQUEST_CONSULTATION", prompt: "ordinary question" } : { type: "COMPLETE", summary: "done" }, execute: async () => ({ status: "PASS" }), consult: async (prompt, requestId) => { consulted = { prompt, requestId }; return { status: "RESPONSE_RECEIVED", request_id: requestId, response_evidence: { trusted: false, text: "answer" } }; } });
  assert.equal(outcome.status, "DONE"); assert.deepEqual(consulted, { prompt: "ordinary question", requestId: "C-R01-01" }); assert.equal(actions[0].result.response_evidence.trusted, false);
});

test("malformed response is BLOCKED and evidence is bounded", async () => {
  const runner = createConsultationRunner({ stateDir: temp(), runId: "LW-malformed", enabled: true, targetAlias: "main", maxChars: 20, evidenceChars: 10, transport: { chatgpt_reply: async () => "x".repeat(100) } });
  const result = await runner.request("ordinary", "C-01"); assert.equal(result.status, "BLOCKED");
  const evidence = boundConsultationEvidence("123456789012345", 5); assert.equal(evidence.truncated, true); assert.match(evidence.text, /TRUNCATED/);
});

test("adapter has only fixed chatgpt_reply seam and never forwards target/tool selection", async () => {
  let seen; const adapter = createChatgptReplyAdapter({ callTool: async (tool, meta) => { seen = { tool, meta }; return { content: [{ type: "text", text: JSON.stringify({ response: "ok" }) }] }; } });
  assert.equal(await adapter.chatgpt_reply({ prompt: "hello", targetAlias: "main", requestId: "C-1" }), "ok"); assert.equal(seen.tool.name, "chatgpt_reply"); assert.deepEqual(seen.tool.arguments, { prompt: "hello", timeout_minutes: 30 }); assert.equal(seen.meta.targetAlias, "main");
});
