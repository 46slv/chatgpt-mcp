import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const SCHEMA_VERSION = 1;

export function defaultRegistryPath(env = process.env) {
  const base = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "DevExec", "targets.json");
}

export function normalizeChatUrl(value) {
  if (typeof value !== "string" || value.trim() === "") throw new Error("Target URL must be a non-empty string.");
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.hostname !== "chatgpt.com") throw new Error("Target URL must use https://chatgpt.com.");
  const match = url.pathname.match(/^\/c\/([A-Za-z0-9-]+)\/?$/);
  if (!match) throw new Error("Target URL must be a ChatGPT conversation URL.");
  return { chat_url: `https://chatgpt.com/c/${match[1]}`, conversation_id: match[1] };
}

export function emptyRegistry() {
  return { schema_version: SCHEMA_VERSION, default_target: null, targets: {} };
}

export function validateRegistry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Target registry must be an object.");
  if (value.schema_version !== SCHEMA_VERSION) throw new Error(`Unsupported target registry schema_version: ${value.schema_version}`);
  if (!value.targets || typeof value.targets !== "object" || Array.isArray(value.targets)) throw new Error("Target registry targets must be an object.");
  for (const [name, target] of Object.entries(value.targets)) {
    if (!name || !target || typeof target !== "object") throw new Error("Invalid target entry.");
    if (target.transport !== "chatgpt-web") throw new Error(`Unsupported transport for target ${name}.`);
    normalizeChatUrl(target.chat_url);
  }
  if (value.default_target !== null && !Object.prototype.hasOwnProperty.call(value.targets, value.default_target)) {
    throw new Error("default_target does not exist in targets.");
  }
  return value;
}

export function loadRegistry(registryPath = defaultRegistryPath()) {
  if (!fs.existsSync(registryPath)) return emptyRegistry();
  return validateRegistry(JSON.parse(fs.readFileSync(registryPath, "utf8")));
}

export function saveRegistry(registry, registryPath = defaultRegistryPath()) {
  validateRegistry(registry);
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  const tempPath = `${registryPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  if (fs.existsSync(registryPath)) {
    fs.copyFileSync(tempPath, registryPath);
    fs.unlinkSync(tempPath);
  } else {
    fs.renameSync(tempPath, registryPath);
  }
  return registryPath;
}

export function setTarget(registry, name, chatUrl, metadata = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name || "")) throw new Error("Target alias contains unsupported characters.");
  const normalized = normalizeChatUrl(chatUrl);
  registry.targets[name] = {
    transport: "chatgpt-web",
    chat_url: normalized.chat_url,
    conversation_id: normalized.conversation_id,
    ...metadata,
  };
  return registry.targets[name];
}

export function useTarget(registry, name) {
  if (!Object.prototype.hasOwnProperty.call(registry.targets, name)) throw new Error(`Unknown target alias: ${name}`);
  registry.default_target = name;
  return registry.targets[name];
}

function readProjectTarget(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, ".devexec.json");
    if (fs.existsSync(candidate)) {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (parsed && typeof parsed.target === "string" && parsed.target.trim()) {
        return { alias: parsed.target.trim(), config_path: candidate };
      }
      return null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolvedTarget(alias, target, source, extra = {}) {
  const normalized = normalizeChatUrl(target.chat_url);
  return {
    target_id: alias,
    transport: target.transport || "chatgpt-web",
    chat_url: normalized.chat_url,
    conversation_id: normalized.conversation_id,
    source,
    ...extra,
  };
}

export function resolveTarget({ explicitTarget = null, cwd = process.cwd(), registry = loadRegistry(), legacyUrl = process.env.CHATGPT_MCP_CHAT_URL || null } = {}) {
  if (explicitTarget) {
    const target = registry.targets[explicitTarget];
    if (!target) throw new Error(`Explicit target alias not found: ${explicitTarget}`);
    return resolvedTarget(explicitTarget, target, "explicit");
  }
  const projectTarget = readProjectTarget(cwd);
  if (projectTarget) {
    const target = registry.targets[projectTarget.alias];
    if (!target) throw new Error(`Project target alias not found: ${projectTarget.alias}`);
    return resolvedTarget(projectTarget.alias, target, "project", { project_config: projectTarget.config_path });
  }
  if (registry.default_target) {
    const target = registry.targets[registry.default_target];
    if (!target) throw new Error(`Default target alias not found: ${registry.default_target}`);
    return resolvedTarget(registry.default_target, target, "registry-default");
  }
  if (legacyUrl) {
    const normalized = normalizeChatUrl(legacyUrl);
    return {
      target_id: "legacy-env",
      transport: "chatgpt-web",
      chat_url: normalized.chat_url,
      conversation_id: normalized.conversation_id,
      source: "legacy-env",
    };
  }
  throw new Error("No Dev Exec target could be resolved.");
}

async function inspectCdpTarget(target) {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      resolve(value);
    };
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const timer = setTimeout(() => finish({ title: target.title || "", url: target.url || "", visibility: "unknown", focused: false }), 2500);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: {
          expression: "JSON.stringify({href:location.href,title:document.title,visibility:document.visibilityState,focused:document.hasFocus()})",
          returnByValue: true,
        },
      }));
    });
    ws.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id !== 1) return;
      clearTimeout(timer);
      try {
        const value = JSON.parse(message.result.result.value);
        finish({
          title: value.title || target.title || "",
          url: value.href || target.url || "",
          visibility: value.visibility || "unknown",
          focused: Boolean(value.focused),
        });
      } catch {
        finish({ title: target.title || "", url: target.url || "", visibility: "unknown", focused: false });
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      finish({ title: target.title || "", url: target.url || "", visibility: "unknown", focused: false });
    });
  });
}

export async function captureCurrentChat({ cdpBase = "http://127.0.0.1:9222" } = {}) {
  const response = await fetch(`${cdpBase}/json/list`);
  if (!response.ok) throw new Error(`CDP target listing failed: HTTP ${response.status}`);
  const targets = await response.json();
  const candidates = targets.filter((target) =>
    target.type === "page" &&
    /^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+(?:[/?#].*)?$/.test(target.url || "") &&
    target.webSocketDebuggerUrl
  );
  const inspected = [];
  for (const target of candidates) inspected.push(await inspectCdpTarget(target));
  const focused = inspected.filter((target) => target.focused);
  const visible = inspected.filter((target) => target.visibility === "visible");
  let selected = null;
  if (focused.length === 1) selected = focused[0];
  else if (visible.length === 1) selected = visible[0];
  else if (inspected.length === 1) selected = inspected[0];
  if (!selected) {
    const error = new Error("Current ChatGPT conversation is ambiguous.");
    error.code = "TARGET_AMBIGUOUS";
    error.candidates = inspected;
    throw error;
  }
  const normalized = normalizeChatUrl(selected.url);
  return {
    transport: "chatgpt-web",
    chat_url: normalized.chat_url,
    conversation_id: normalized.conversation_id,
    title: selected.title,
    captured_at: new Date().toISOString(),
  };
}
