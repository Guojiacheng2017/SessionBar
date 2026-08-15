import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, css] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/web.css", import.meta.url), "utf8"),
]);

test("uses the system color scheme as the Web UI theme source", () => {
  assert.match(html, /color-scheme" content="light dark"/);
  assert.match(html, /darkMode:\s*['"]media['"]/);
  assert.doesNotMatch(html, /<html[^>]+class=["'][^"']*\bdark\b/i);
  assert.match(css, /@media\s*\(prefers-color-scheme:\s*dark\)/);
  assert.match(css, /--sb-canvas:\s*#f4f6fa/);
  assert.match(css, /--sb-canvas:\s*#08080d/);
});
