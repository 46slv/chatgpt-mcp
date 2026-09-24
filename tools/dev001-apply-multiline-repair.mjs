import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const sourceUrl = new URL('../src/chatgpt.ts', import.meta.url);
const before = "  cleaned = cleaned.replace(/\\s+/g, ' ').trim();";
const after = "  cleaned = cleaned.replace(/\\r\\n?/g, '\\n').trim();";

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const countExact = (value, needle) => value.split(needle).length - 1;

const original = await readFile(sourceUrl, 'utf8');
const beforeCount = countExact(original, before);
const afterCount = countExact(original, after);

if (beforeCount === 0 && afterCount === 1) {
  console.log(`DEV001_MULTILINE_REPAIR=ALREADY_APPLIED sha256=${sha256(original)}`);
  process.exit(0);
}

if (beforeCount !== 1 || afterCount !== 0) {
  throw new Error(
    `DEV001_MULTILINE_REPAIR_SOURCE_DRIFT before_count=${beforeCount} after_count=${afterCount}`,
  );
}

const repaired = original.replace(before, after);
if (repaired === original || countExact(repaired, before) !== 0 || countExact(repaired, after) !== 1) {
  throw new Error('DEV001_MULTILINE_REPAIR_POSTCONDITION_FAILED');
}

await writeFile(sourceUrl, repaired, 'utf8');
const readback = await readFile(sourceUrl, 'utf8');
if (readback !== repaired) {
  throw new Error('DEV001_MULTILINE_REPAIR_READBACK_MISMATCH');
}

console.log(`DEV001_MULTILINE_REPAIR=APPLIED before_sha256=${sha256(original)} after_sha256=${sha256(repaired)}`);
