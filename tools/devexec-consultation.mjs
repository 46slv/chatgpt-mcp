import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const CONSULTATION_PROTOCOL = "devexec.chatgpt-consultation";
export const CONSULTATION_SCHEMA_VERSION = 1;
export const CONSULTATION_PHASES = new Set(["PREPARED", "IN_FLIGHT", "RESPONSE_RECEIVED", "BLOCKED", "DELIVERY_UNKNOWN"]);
export const DEFAULT_CONSULTATION_MAX_CHARS = 12000;
export const DEFAULT_CONSULTATION_EVIDENCE_CHARS = 6000;

function hash(value) { return crypto.createHash("sha256").update(String(value), "utf8").digest("hex"); }
function exactKeys(value, keys) { return !!value && typeof value === "object" && !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()); }
function validId(value) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,96}$/.test(value) || value.includes("..") || path.isAbsolute(value)) throw new Error("invalid consultation id"); return value; }

export function consultationEnabled(env = process.env) { return env.DEV_EXEC_CHATGPT_CONSULT_ENABLED === "1"; }

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

export function createConsultationRunner({ stateDir, runId, enabled = false, targetAlias, targetUrl = null, transport, maxChars = DEFAULT_CONSULTATION_MAX_CHARS, evidenceChars = DEFAULT_CONSULTATION_EVIDENCE_CHARS, maxRequests = 3 } = {}) {
  if (!stateDir || !runId) throw new Error("consultation stateDir and runId required");
  validId(runId);
  if (!transport || typeof transport.chatgpt_reply !== "function") throw new Error("fixed chatgpt_reply transport required");
  if (typeof targetAlias !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(targetAlias)) throw new Error("fixed consultation target alias required");
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 12000) throw new Error("invalid consultation request budget");
  if (!Number.isInteger(evidenceChars) || evidenceChars < 1 || evidenceChars > 12000) throw new Error("invalid consultation evidence budget");
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 10) throw new Error("invalid consultation request count budget");
  const file = path.join(stateDir, `${runId}.json`);
  let state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : defaultState(runId, { alias: targetAlias, url: targetUrl, frozen_at: new Date().toISOString() }, { max_chars: maxChars, evidence_chars: evidenceChars, max_requests: maxRequests });
  if (state.run_id !== runId || state.protocol !== CONSULTATION_PROTOCOL || state.schema_version !== CONSULTATION_SCHEMA_VERSION) throw new Error("consultation state mismatch");
  if (state.target?.alias !== targetAlias || (targetUrl && state.target.url && state.target.url !== targetUrl)) throw new Error("consultation target is not frozen");
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
    try { raw = await transport.chatgpt_reply({ prompt: text, targetAlias, requestId: id }); }
    catch (error) { record.phase = "DELIVERY_UNKNOWN"; record.reason = String(error?.message || error); record.delivery_unknown_at = new Date().toISOString(); state.phase = "DELIVERY_UNKNOWN"; save(); return result(record, { retry: false }); }
    const response = typeof raw === "string" ? raw : raw?.response;
    if (typeof response !== "string" || !response.trim() || response.length > maxChars * 4) { record.phase = "BLOCKED"; record.reason = "malformed_or_overlong_response"; record.blocked_at = new Date().toISOString(); state.phase = "BLOCKED"; save(); return result(record); }
    record.response_evidence = boundConsultationEvidence(response, evidenceChars); record.phase = "RESPONSE_RECEIVED"; record.received_at = new Date().toISOString(); state.phase = "RESPONSE_RECEIVED"; save();
    return result(record, { cached: false });
  }
  function snapshot() { return JSON.parse(JSON.stringify(state)); }
  return { file, target: { ...state.target }, request, snapshot };
}

export function createChatgptReplyAdapter({ callTool, timeoutMinutes = 30 } = {}) {
  if (typeof callTool !== "function") throw new Error("callTool required");
  return { chatgpt_reply: async ({ prompt, targetAlias, requestId } = {}) => {
    if (typeof prompt !== "string" || !prompt.trim() || typeof targetAlias !== "string" || typeof requestId !== "string") throw new Error("fixed chatgpt_reply request fields required");
    const result = await callTool({ name: "chatgpt_reply", arguments: { prompt, timeout_minutes: timeoutMinutes } }, { targetAlias, requestId });
    if (result?.isError) throw new Error("chatgpt_reply MCP error");
    const blocks = (result?.content || []).filter(item => item.type === "text").map(item => item.text);
    if (blocks.length !== 1) throw new Error("chatgpt_reply expected exactly one text block");
    let value; try { value = JSON.parse(blocks[0]); } catch { throw new Error("chatgpt_reply malformed JSON"); }
    if (typeof value.error === "string" && value.error.trim()) throw new Error(value.error.trim());
    if (typeof value.response !== "string" || !value.response.trim()) throw new Error("chatgpt_reply empty response");
    return value.response;
  } };
}
