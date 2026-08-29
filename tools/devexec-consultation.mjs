import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseChatGPTTargetUrl } from "./target-registry.mjs";

export const CONSULTATION_PROTOCOL = "devexec.chatgpt-consultation";
export const CONSULTATION_SCHEMA_VERSION = 1;
export const CONSULTATION_PHASES = new Set(["PREPARED", "IN_FLIGHT", "RESPONSE_RECEIVED", "BLOCKED", "DELIVERY_UNKNOWN"]);
export const DEFAULT_CONSULTATION_MAX_CHARS = 12000;
export const DEFAULT_CONSULTATION_EVIDENCE_CHARS = 6000;
export const DEFAULT_CONSULTATION_MAX_REQUESTS = 3;
export const DEFAULT_CONSULTATION_TIMEOUT_MINUTES = 30;
export const CONSULTATION_LIMITS = Object.freeze({
  maxRequests: Object.freeze({ min: 1, max: 10 }),
  maxChars: Object.freeze({ min: 1, max: 12000 }),
  evidenceChars: Object.freeze({ min: 1, max: 12000 }),
  timeoutMinutes: Object.freeze({ min: 1, max: 120 }),
});

function hash(value) { return crypto.createHash("sha256").update(String(value), "utf8").digest("hex"); }
function exactKeys(value, keys) { return !!value && typeof value === "object" && !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()); }
function validId(value) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,96}$/.test(value) || value.includes("..") || path.isAbsolute(value)) throw new Error("invalid consultation id"); return value; }

export function consultationEnabled(env = process.env) { return env.DEV_EXEC_CHATGPT_CONSULT_ENABLED === "1"; }

function boundedEnvInteger(env, name, fallback, bounds) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return { value: fallback, valid: true, clamped: false };
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return { value: fallback, valid: false, clamped: false, reason: `${name}_malformed` };
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) return { value: fallback, valid: false, clamped: false, reason: `${name}_malformed` };
  const value = Math.min(bounds.max, Math.max(bounds.min, parsed));
  return { value, valid: true, clamped: value !== parsed };
}

/**
 * Read the process-local consultation controls. Numeric values outside the
 * contract are clamped; malformed values invalidate the standing opt-in so a
 * typo cannot silently widen or alter a live request policy.
 */
export function consultationConfig(env = process.env) {
  const limits = {
    maxRequests: boundedEnvInteger(env, "DEV_EXEC_CHATGPT_CONSULT_MAX_REQUESTS", DEFAULT_CONSULTATION_MAX_REQUESTS, CONSULTATION_LIMITS.maxRequests),
    maxChars: boundedEnvInteger(env, "DEV_EXEC_CHATGPT_CONSULT_MAX_CHARS", DEFAULT_CONSULTATION_MAX_CHARS, CONSULTATION_LIMITS.maxChars),
    evidenceChars: boundedEnvInteger(env, "DEV_EXEC_CHATGPT_CONSULT_EVIDENCE_CHARS", DEFAULT_CONSULTATION_EVIDENCE_CHARS, CONSULTATION_LIMITS.evidenceChars),
    timeoutMinutes: boundedEnvInteger(env, "DEV_EXEC_CHATGPT_CONSULT_TIMEOUT_MINUTES", DEFAULT_CONSULTATION_TIMEOUT_MINUTES, CONSULTATION_LIMITS.timeoutMinutes),
  };
  const invalid = Object.values(limits).filter(item => !item.valid).map(item => item.reason);
  return {
    enabled: consultationEnabled(env) && invalid.length === 0,
    requestedEnabled: consultationEnabled(env),
    valid: invalid.length === 0,
    invalid,
    maxRequests: limits.maxRequests.value,
    maxChars: limits.maxChars.value,
    evidenceChars: limits.evidenceChars.value,
    timeoutMinutes: limits.timeoutMinutes.value,
    clamped: Object.fromEntries(Object.entries(limits).filter(([, item]) => item.clamped).map(([key]) => [key, true])),
  };
}

export function classifyConsultationPrompt(prompt, { maxChars = DEFAULT_CONSULTATION_MAX_CHARS } = {}) {
  const text = String(prompt ?? "").trim();
  if (!text || text.length > maxChars) return { decision: "BLOCK", category: "unknown", reason: "empty_or_over_budget" };
  const rules = [
    ["secrets", /(?:api[_ -]?key|access[_ -]?token|password|secret|credential|cookie|bearer|private key|ssh key|2fa|one[- ]time code)/i],
    ["personal_data", /(?:personal data|pii|phone number|email address|home address|social security|medical record|passport|date of birth)/i],
    ["file_upload", /(?:upload|attach|file path|local file|\.pdf\b|\.docx?\b|\.zip\b)/i],
    ["permission", /(?:permission|authorize|approval|sudo|administrator|admin access|bypass|allow me)/i],
    ["account", /(?:account|login|log in|sign in|password reset|session|cookie)/i],
    ["billing", /(?:billing|payment|credit card|invoice|purchase|subscription|refund)/i],
    ["destructive", /(?:delete|remove|drop database|reset --hard|force[- ]push|shutdown|wipe|destroy|overwrite)/i],
    ["out_of_scope", /(?:ignore (?:all|previous|prior) instructions|system prompt|developer message|tool call|send (?:an )?(?:email|message)|chatgpt action|execute this command|run this command)/i],
  ];
  for (const [category, pattern] of rules) if (pattern.test(text)) return { decision: "BLOCK", category, reason: category };
  if (/```|(?:^|\s)(?:[A-Za-z]:\\|\\\\|\/Users\/|\/home\/|https?:\/\/)/i.test(text)) return { decision: "BLOCK", category: "out_of_scope", reason: "path_or_external_reference" };
  return { decision: "ALLOW", category: "ordinary_text", reason: "ordinary_text" };
}

export function consultationRequestHash({ targetAlias, prompt }) { return hash(JSON.stringify({ target_alias: String(targetAlias || ""), prompt: String(prompt || "") })); }

export function boundConsultationEvidence(response, maxChars = DEFAULT_CONSULTATION_EVIDENCE_CHARS) {
  const text = String(response ?? "");
  const bounded = text.length > maxChars ? `${text.slice(0, maxChars)}...[TRUNCATED]` : text;
  return { trusted: false, text: bounded, sha256: hash(text), chars: text.length, truncated: text.length > maxChars };
}

function defaultState(runId, target, limits = {}) {
  return { protocol: CONSULTATION_PROTOCOL, schema_version: CONSULTATION_SCHEMA_VERSION, run_id: validId(runId), target, limits, phase: "PREPARED", active_request_id: null, requests: {}, updated_at: new Date().toISOString() };
}

export function createConsultationRunner({ stateDir, runId, enabled = false, targetAlias, targetUrl = null, targetConversationId = null, targetSource = "unknown", frozenTarget = null, transport, maxChars = DEFAULT_CONSULTATION_MAX_CHARS, evidenceChars = DEFAULT_CONSULTATION_EVIDENCE_CHARS, maxRequests = DEFAULT_CONSULTATION_MAX_REQUESTS, timeoutMinutes = DEFAULT_CONSULTATION_TIMEOUT_MINUTES } = {}) {
  if (!stateDir || !runId) throw new Error("consultation stateDir and runId required");
  validId(runId);
  if (!transport || typeof transport.chatgpt_reply !== "function") throw new Error("fixed chatgpt_reply transport required");
  if (typeof targetAlias !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(targetAlias)) throw new Error("fixed consultation target alias required");
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 12000) throw new Error("invalid consultation request budget");
  if (!Number.isInteger(evidenceChars) || evidenceChars < 1 || evidenceChars > 12000) throw new Error("invalid consultation evidence budget");
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 10) throw new Error("invalid consultation request count budget");
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 120) throw new Error("invalid consultation timeout budget");
  const parsedTarget = frozenTarget ? parseChatGPTTargetUrl(frozenTarget.url) : (targetUrl ? parseChatGPTTargetUrl(targetUrl) : null);
  if (frozenTarget && (frozenTarget.alias !== targetAlias || frozenTarget.conversation_id !== parsedTarget.conversation_id)) throw new Error("frozen consultation target mismatch");
  const expectedTarget = { alias: targetAlias, url: parsedTarget?.chat_url || null, conversation_id: targetConversationId || parsedTarget?.conversation_id || null, source: frozenTarget?.source || targetSource || "unknown", frozen_at: frozenTarget?.frozen_at || new Date().toISOString() };
  const file = path.join(stateDir, `${runId}.json`);
  let state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : defaultState(runId, expectedTarget, { max_chars: maxChars, evidence_chars: evidenceChars, max_requests: maxRequests, timeout_minutes: timeoutMinutes });
  if (state.run_id !== runId || state.protocol !== CONSULTATION_PROTOCOL || state.schema_version !== CONSULTATION_SCHEMA_VERSION) throw new Error("consultation state mismatch");
  if (state.target?.alias !== targetAlias || (expectedTarget.url && state.target.url !== expectedTarget.url) || (expectedTarget.conversation_id && state.target.conversation_id && state.target.conversation_id !== expectedTarget.conversation_id)) throw new Error("consultation target is not frozen");
  if (expectedTarget.url && !state.target.conversation_id) state.target = { ...state.target, ...expectedTarget };
  fs.mkdirSync(stateDir, { recursive: true });
  function save() { state.updated_at = new Date().toISOString(); const tmp = `${file}.tmp-${process.pid}`; fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8"); fs.renameSync(tmp, file); }
  function result(record, extra = {}) { return { status: record.phase, request_id: record.request_id, request_sha256: record.request_sha256, target_alias: targetAlias, response_evidence: record.response_evidence || null, reason: record.reason || null, ...extra }; }
  async function request(prompt, requestId) {
    const text = String(prompt ?? "").trim();
    const id = validId(requestId || `C-${Date.now()}`);
    const requestHash = consultationRequestHash({ targetAlias, prompt: text });
    const cached = Object.values(state.requests).find(item => item.request_sha256 === requestHash);
    if (cached?.phase === "RESPONSE_RECEIVED") return result(cached, { cached: true });
    if (cached && ["IN_FLIGHT", "DELIVERY_UNKNOWN"].includes(cached.phase)) return result(cached, { cached: false, retry: false, reason: "ambiguous_delivery_no_retry" });
    if (Object.keys(state.requests).length >= maxRequests) { const budgetRecord = { request_id: id, request_sha256: requestHash, target_alias: targetAlias, prompt_chars: text.length, classification: { decision: "BLOCK", category: "budget", reason: "request_budget_exhausted" }, phase: "BLOCKED", reason: "request_budget_exhausted", blocked_at: new Date().toISOString(), response_evidence: null }; state.requests[id] = budgetRecord; state.phase = "BLOCKED"; state.active_request_id = id; save(); return result(budgetRecord, { retry: false }); }
    const classification = enabled ? classifyConsultationPrompt(text, { maxChars }) : { decision: "BLOCK", category: "disabled", reason: "standing_opt_in_required" };
    const record = { request_id: id, request_sha256: requestHash, target_alias: targetAlias, prompt_chars: text.length, classification, phase: "PREPARED", prepared_at: new Date().toISOString(), response_evidence: null, reason: null };
    state.requests[id] = record; state.phase = "PREPARED"; state.active_request_id = id; save();
    if (classification.decision !== "ALLOW") { record.phase = "BLOCKED"; record.reason = classification.reason; record.blocked_at = new Date().toISOString(); state.phase = "BLOCKED"; save(); return result(record); }
    record.phase = "IN_FLIGHT"; record.sent_at = new Date().toISOString(); state.phase = "IN_FLIGHT"; save();
    let raw;
    try {
      const request = { prompt: text, targetAlias, requestId: id, timeoutMinutes };
      // Target identity is runner-owned. Keep it out of the planner schema,
      // but carry the frozen URL/id across the transport boundary so the MCP
      // server can navigate and verify the exact prepared conversation.
      if (state.target?.url) request.target_url = state.target.url;
      if (state.target?.conversation_id) request.expected_conversation_id = state.target.conversation_id;
      raw = await transport.chatgpt_reply(request);
    }
    catch (error) { record.phase = "DELIVERY_UNKNOWN"; record.reason = String(error?.message || error); record.delivery_unknown_at = new Date().toISOString(); state.phase = "DELIVERY_UNKNOWN"; save(); return result(record, { retry: false }); }
    const response = typeof raw === "string" ? raw : raw?.response;
    if (typeof response !== "string" || !response.trim() || response.length > maxChars * 4) { record.phase = "BLOCKED"; record.reason = "malformed_or_overlong_response"; record.blocked_at = new Date().toISOString(); state.phase = "BLOCKED"; save(); return result(record); }
    record.response_evidence = boundConsultationEvidence(response, evidenceChars); record.phase = "RESPONSE_RECEIVED"; record.received_at = new Date().toISOString(); state.phase = "RESPONSE_RECEIVED"; save();
    return result(record, { cached: false });
  }
  function snapshot() { return JSON.parse(JSON.stringify(state)); }
  return { file, target: { ...state.target }, request, snapshot };
}

export function createChatgptReplyAdapter({ callTool, timeoutMinutes = 30, targetUrl = null, targetConversationId = null } = {}) {
  if (typeof callTool !== "function") throw new Error("callTool required");
  let fixedTarget = null;
  if (targetUrl !== null && targetUrl !== undefined) {
    const parsed = parseChatGPTTargetUrl(targetUrl);
    if (targetConversationId !== null && targetConversationId !== undefined && targetConversationId !== parsed.conversation_id) throw new Error("fixed target URL and conversation id mismatch");
    fixedTarget = { url: parsed.chat_url, conversation_id: parsed.conversation_id };
  } else if (targetConversationId !== null && targetConversationId !== undefined) {
    throw new Error("fixed target conversation id requires target URL");
  }
  return { chatgpt_reply: async ({ prompt, targetAlias, requestId, target_url, expected_conversation_id } = {}) => {
    if (typeof prompt !== "string" || !prompt.trim() || typeof targetAlias !== "string" || typeof requestId !== "string") throw new Error("fixed chatgpt_reply request fields required");
    const requestedUrl = fixedTarget?.url || target_url || null;
    const requestedId = fixedTarget?.conversation_id || expected_conversation_id || null;
    let requestTarget = null;
    if (requestedUrl !== null || requestedId !== null) {
      if (requestedUrl === null) throw new Error("target_url required for targeted chatgpt_reply");
      const parsed = parseChatGPTTargetUrl(requestedUrl);
      if (requestedId !== null && requestedId !== parsed.conversation_id) throw new Error("target URL and expected conversation id mismatch");
      requestTarget = parsed;
    }
    const argumentsValue = { prompt, timeout_minutes: timeoutMinutes };
    if (requestTarget) {
      argumentsValue.target_url = requestTarget.chat_url;
      argumentsValue.expected_conversation_id = requestTarget.conversation_id;
    }
    const meta = { targetAlias, requestId };
    if (requestTarget) {
      meta.target_url = requestTarget.chat_url;
      meta.expected_conversation_id = requestTarget.conversation_id;
    }
    const result = await callTool({ name: "chatgpt_reply", arguments: argumentsValue }, meta);
    if (result?.isError) throw new Error("chatgpt_reply MCP error");
    const blocks = (result?.content || []).filter(item => item.type === "text").map(item => item.text);
    if (blocks.length !== 1) throw new Error("chatgpt_reply expected exactly one text block");
    let value; try { value = JSON.parse(blocks[0]); } catch { throw new Error("chatgpt_reply malformed JSON"); }
    if (typeof value.error === "string" && value.error.trim()) throw new Error(value.error.trim());
    if (typeof value.response !== "string" || !value.response.trim()) throw new Error("chatgpt_reply empty response");
    if (requestTarget && value.chat_id !== requestTarget.conversation_id) {
      const error = new Error("chatgpt_reply conversation identity mismatch");
      error.code = "TARGET_CONVERSATION_MISMATCH";
      throw error;
    }
    return value.response;
  } };
}
