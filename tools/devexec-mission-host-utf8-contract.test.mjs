import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const wrapper = path.join(HERE, "verify-devexec-mission-host-acceptance.ps1");

function source() {
  return fs.readFileSync(wrapper, "utf8");
}

test("host wrapper writes evidence with explicit UTF-8 without BOM", () => {
  const text = source();
  assert.match(text, /New-Object System\.Text\.UTF8Encoding\(\$false\)/);
  assert.match(text, /\[System\.IO\.File\]::WriteAllText\(\$Path, \$Text, \$script:Utf8NoBom\)/);
  assert.match(text, /Write-Utf8NoBom -Path \$outputFile -Text \$outputText/);
  assert.match(text, /Write-Utf8NoBom -Path \$summaryPath -Text \(\$summaryJson \+ \[Environment\]::NewLine\)/);
  assert.doesNotMatch(text, /Set-Content[^\r\n]+-Encoding UTF8/);
});

test("the Windows PowerShell 5.1 UTF-8 BOM would make Node JSON.parse reject SUMMARY bytes", () => {
  const bomJson = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('{"protocol":"devexec.mission-host-acceptance"}\n', "utf8"),
  ]).toString("utf8");
  assert.throws(() => JSON.parse(bomJson), SyntaxError);
});
