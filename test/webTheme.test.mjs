import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, css, tailwindConfig] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/web.css", import.meta.url), "utf8"),
  readFile(new URL("../tailwind.config.cjs", import.meta.url), "utf8"),
]);

test("page boundaries, header geometry and viewport sizing share one frame", () => {
  assert.match(css, /\.app-shell\s*\{[^}]*max-width: var\(--sb-page-max-width\)[^}]*padding: var\(--sb-page-inset-block\) var\(--sb-page-inset-inline\)/s);
  assert.match(css, /height: calc\(100svh - 2 \* var\(--sb-page-inset-block\)\)/);
  assert.match(css, /\.connection-pill\s*\{[^}]*height: 30px/s);
  assert.match(css, /#filter-hint:empty\s*\{ display: none; \}/);
  assert.doesNotMatch(css, /padding: (?:20px 24px 32px|12px 10px 32px)/);
});

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

test("provider density preserves full metadata and the shared 88px usage plot", () => {
  assert.match(css, /\.provider-usage\s*\{[^}]*width: 88px;[^}]*min-width: 88px;[^}]*flex: 0 0 88px/s);
  assert.match(css, /\.provider-usage-empty\s*\{[^}]*justify-content: space-between/s);
  assert.match(css, /grid-template-columns: minmax\(180px, 1\.3fr\).*120px minmax\(160px, \.9fr\) minmax\(140px, \.8fr\)/);
  assert.match(css, /\.provider-level\s*\{[^}]*flex-direction: column[^}]*white-space: normal/s);
  assert.match(css, /\.provider-level-rate\s*\{[^}]*overflow-wrap: anywhere/s);
  assert.match(css, /\.provider-gallery-card \.provider-name small\s*\{[^}]*white-space: normal/s);
  assert.match(css, /\.provider-table-desktop \.provider-row\s*\{ min-width: 940px/);
});
