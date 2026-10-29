import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("bilingual recent updates stay bounded to five completed dated entries", () => {
  for (const [file, heading] of [["README.md", "What's New"], ["README.zh-CN.md", "最新动态"]]) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const section = text.split(`## ${heading}\n`)[1].split("> [!NOTE]")[0];
    const entries = section.match(/^- \*\*/gm) ?? [];
    assert.equal(entries.length, 5, file);
    assert.equal((section.match(/\*\*\d{4}-\d{2}-\d{2}/g) ?? []).length, 5, file);
    assert.doesNotMatch(section, /\b(?:pending|todo)\b|待办|未完成/i);
  }
});
