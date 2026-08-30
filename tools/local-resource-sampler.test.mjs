import test from "node:test";
import assert from "node:assert/strict";
import { createParentResourceSampler, sampleParentGpu } from "./local-resource-sampler.mjs";

test("parent sampler records numeric before/peak/after and cleans timers", () => {
  let ram = 10; let gpu = 20; let intervalCallback = null; let clearedInterval = 0; let clearedTimeout = 0;
  const sampler = createParentResourceSampler({
    deviceIndex: 1,
    intervalMs: 25,
    sampleRam: () => ram,
    sampleGpu: () => ({ memory_mb: gpu, utilization_pct: gpu / 2 }),
    setIntervalImpl: (fn) => { intervalCallback = fn; return 1; },
    clearIntervalImpl: () => { clearedInterval += 1; },
    setTimeoutImpl: () => 2,
    clearTimeoutImpl: () => { clearedTimeout += 1; },
  });
  sampler.start(); ram = 30; gpu = 80; intervalCallback(); const result = sampler.stop();
  assert.deepEqual(result.ram_mb, { before: 10, peak: 30, after: 30, availability: "AVAILABLE", available: true });
  assert.deepEqual(result.vram_mb, { before: 20, peak: 80, after: 80, availability: "AVAILABLE", available: true });
  assert.deepEqual(result.gpu_utilization_pct, { before: 10, peak: 40, after: 40, availability: "AVAILABLE", available: true });
  assert.equal(clearedInterval, 1); assert.equal(clearedTimeout, 1);
});

test("provider failure still captures target GPU and unavailable telemetry is NOT_COLLECTED", () => {
  const sampler = createParentResourceSampler({ sampleRam: () => null, sampleGpu: () => ({ memory_mb: null, utilization_pct: null }), setIntervalImpl: () => 1, setTimeoutImpl: () => 2 });
  sampler.start(); const result = sampler.stop();
  for (const key of ["ram_mb", "vram_mb", "gpu_utilization_pct"]) {
    assert.equal(result[key].availability, "NOT_COLLECTED");
    assert.equal(result[key].available, null);
    assert.equal(result[key].before, null); assert.equal(result[key].peak, null); assert.equal(result[key].after, null);
  }
});

test("GPU sampler parses only target index and never returns process metadata", () => {
  const calls = [];
  const result = sampleParentGpu(1, { execFileSyncImpl: (...args) => { calls.push(args); return "0, 512, 80\n1, 1024, 65\n"; } });
  assert.deepEqual(result, { memory_mb: 1024, utilization_pct: 65 });
  assert.equal(Object.keys(result).some((key) => ["pid", "process_name", "path"].includes(key)), false);
  assert.equal(calls[0][1][0], "--query-gpu=index,memory.used,utilization.gpu");
});
