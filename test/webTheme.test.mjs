import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, css, tailwindConfig] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/web.css", import.meta.url), "utf8"),
  readFile(new URL("../tailwind.config.cjs", import.meta.url), "utf8"),
]);

test("uses the system color scheme as the Web UI theme source", () => {
  assert.match(html, /color-scheme" content="light dark"/);
  assert.match(html, /href="\.\/tailwind\.css"/);
  assert.doesNotMatch(html, /cdn\.tailwindcss\.com|tailwind\.config/);
  assert.match(tailwindConfig, /darkMode:\s*"media"/);
  assert.doesNotMatch(html, /<html[^>]+class=["'][^"']*\bdark\b/i);
  assert.match(css, /@media\s*\(prefers-color-scheme:\s*dark\)/);
  assert.match(css, /--sb-canvas:\s*#f5f6f7/);
  assert.match(css, /--sb-canvas:\s*#17191c/);
  assert.match(css, /--sb-accent:\s*#426da9/);
  assert.match(css, /--sb-accent:\s*#83a8dc/);
});

test("keeps long current activity readable and state feedback consistent", () => {
  assert.match(css, /\.detail-now-title strong\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*white-space:\s*normal/s);
  assert.match(css, /\.panel-empty\s*\{[^}]*min-height:\s*132px/s);
  assert.match(css, /\.connection-banner\s*\{[^}]*var\(--sb-red\)[^}]*var\(--sb-surface\)/s);
  assert.match(css, /\.connection-banner\[hidden\]\s*\{\s*display:\s*none;/s);
  assert.match(html, /<section class="dashboard-page sessions-page"[^>]*>\s*<div id="connection-banner"/s);
});
