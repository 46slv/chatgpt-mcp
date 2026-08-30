import process from "node:process";
import { execFileSync } from "node:child_process";

const MB = 1024 * 1024;
const AVAILABILITY = Object.freeze({ AVAILABLE: "AVAILABLE", NOT_COLLECTED: "NOT_COLLECTED" });

function finite(value, max = 3_600_000) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= max ? number : null;
}

function metricResource(values, max = 3_600_000) {
  const clean = values.map((value) => finite(value, max));
  const available = clean.some((value) => value !== null);
  return {
    before: clean[0] ?? null,
    peak: available ? Math.max(...clean.filter((value) => value !== null)) : null,
    after: clean[clean.length - 1] ?? null,
    availability: available ? AVAILABILITY.AVAILABLE : AVAILABILITY.NOT_COLLECTED,
    available: available ? true : null,
  };
}

/** Parent RSS only; no PID/process/path is returned or persisted. */
export function sampleParentRamMb() {
  try {
    const rss = process.memoryUsage()?.rss;
    return finite(rss == null ? null : rss / MB);
  } catch {
    return null;
  }
}

function parseGpuQuery(output, deviceIndex) {
  for (const line of String(output || "").split(/\r?\n/)) {
    const fields = line.split(",").map((value) => value.trim());
    if (Number(fields[0]) !== deviceIndex) continue;
    const memory = /^\d+(?:\.\d+)?$/.test(fields[1] || "") ? Number(fields[1]) : null;
    const utilization = /^\d+(?:\.\d+)?$/.test(fields[2] || "") ? Number(fields[2]) : null;
    return { memory_mb: finite(memory), utilization_pct: finite(utilization, 100) };
  }
  return { memory_mb: null, utilization_pct: null };
}

/** Read target GPU telemetry without enumerating or exposing client processes. */
export function sampleParentGpu(deviceIndex = 0, { execFileSyncImpl = execFileSync } = {}) {
  try {
    const output = execFileSyncImpl("nvidia-smi", ["--query-gpu=index,memory.used,utilization.gpu", "--format=csv,noheader,nounits"], { encoding: "utf8", windowsHide: true, timeout: 2000 });
    return parseGpuQuery(output, deviceIndex);
  } catch {
    return { memory_mb: null, utilization_pct: null };
  }
}

/**
 * Bounded, cancellable parent sampler. A provider is never asked for resource
 * values; only this owner captures before/peak/after values for the ledger.
 */
export function createParentResourceSampler({
  deviceIndex = 0,
  intervalMs = 250,
  maxDurationMs = 3_600_000,
  signal = null,
  sampleRam = sampleParentRamMb,
  sampleGpu = (index) => sampleParentGpu(index),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const period = Math.max(25, Math.min(60_000, Number.isFinite(Number(intervalMs)) ? Number(intervalMs) : 250));
  const maxDuration = Math.max(period, Math.min(3_600_000, Number.isFinite(Number(maxDurationMs)) ? Number(maxDurationMs) : 3_600_000));
  const ram = []; const vram = []; const utilization = [];
  let intervalHandle = null; let deadlineHandle = null; let onAbort = null; let started = false; let stopped = false; let sampling = false;
  const capture = () => {
    if (stopped || sampling) return;
    sampling = true;
    try {
      let ramValue = null; let gpuValue = null;
      try { const value = sampleRam(); ramValue = typeof value === "object" ? value?.ram_mb : value; } catch { /* best effort */ }
      try { gpuValue = sampleGpu(deviceIndex); } catch { /* best effort */ }
      const memory = typeof gpuValue === "object" ? (gpuValue?.memory_mb ?? gpuValue?.memory_used_mb) : null;
      const util = typeof gpuValue === "object" ? (gpuValue?.utilization_pct ?? gpuValue?.gpu_utilization_pct) : null;
      ram.push(finite(ramValue)); vram.push(finite(memory)); utilization.push(finite(util, 100));
    } finally { sampling = false; }
  };
  const cleanup = () => {
    if (intervalHandle !== null) clearIntervalImpl(intervalHandle);
    if (deadlineHandle !== null) clearTimeoutImpl(deadlineHandle);
    intervalHandle = null; deadlineHandle = null;
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    onAbort = null;
  };
  const stop = () => {
    if (stopped) return snapshot();
    capture();
    stopped = true;
    cleanup();
    return snapshot();
  };
  const start = () => {
    if (started) return snapshot();
    started = true;
    capture();
    if (signal?.aborted) return stop();
    intervalHandle = setIntervalImpl(capture, period);
    deadlineHandle = setTimeoutImpl(stop, maxDuration);
    onAbort = () => stop();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    return snapshot();
  };
  function snapshot() {
    return { ram_mb: metricResource(ram), vram_mb: metricResource(vram), gpu_utilization_pct: metricResource(utilization, 100) };
  }
  return Object.freeze({ start, stop, snapshot });
}

export const PARENT_RESOURCE_AVAILABILITY = AVAILABILITY;
