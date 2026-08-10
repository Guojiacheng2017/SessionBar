import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const cliSource = readFileSync(new URL("../cli.ts", import.meta.url), "utf8");

function functionBody(name) {
  const declaration = new RegExp(`async function ${name}\\s*\\([^)]*\\)`);
  const match = declaration.exec(cliSource);
  const start = match?.index ?? -1;
  assert.notEqual(start, -1, `${name} function exists`);
  const brace = cliSource.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < cliSource.length; i++) {
    if (cliSource[i] === "{") depth++;
    else if (cliSource[i] === "}") {
      depth--;
      if (depth === 0) return cliSource.slice(brace + 1, i);
    }
  }
  throw new Error(`Could not extract ${name} body`);
}

test("setup configures hooks without starting or stopping the relay", () => {
  const setupBody = functionBody("setup");
  assert.doesNotMatch(setupBody, /ensureServerRunning|startServer|stopServer/);
});

test("service readiness does not register hooks as a side effect", () => {
  const serviceBody = functionBody("ensureServerRunning");
  assert.doesNotMatch(serviceBody, /injectHooksOnServerReady|setupClaudeHooks/);
});

test("interactive app readiness is the hook registration boundary", () => {
  assert.match(cliSource, /async function ensureAppRunning\s*\(/);
  const appBody = functionBody("ensureAppRunning");
  assert.match(appBody, /ensureServerRunning/);
  assert.match(appBody, /injectHooksOnServerReady/);
});

test("status and start paths do not register hooks", () => {
  const statusBody = functionBody("status");
  assert.doesNotMatch(statusBody, /injectHooksOnServerReady|setupClaudeHooks/);
  const startCase = cliSource.slice(cliSource.indexOf('case "start":'), cliSource.indexOf('case "stop":'));
  assert.doesNotMatch(startCase, /injectHooksOnServerReady|setupClaudeHooks/);
});

test("landing menu exit does not stop the background relay", () => {
  // runLandingMenu lives in landingMenu.ts since Phase 6 extraction
  const landingSource = readFileSync(new URL("../landingMenu.ts", import.meta.url), "utf8");
  const decl = new RegExp(`async function runLandingMenu\\s*\\([^)]*\\)`);
  const match = decl.exec(landingSource);
  const start = match?.index ?? -1;
  assert.notEqual(start, -1, "runLandingMenu function exists");
  const brace = landingSource.indexOf("{", start);
  let depth = 0;
  let menuBody = "";
  for (let i = brace; i < landingSource.length; i++) {
    if (landingSource[i] === "{") depth++;
    else if (landingSource[i] === "}") {
      depth--;
      if (depth === 0) { menuBody = landingSource.slice(brace + 1, i); break; }
    }
  }
  assert.doesNotMatch(menuBody, /stopServer\(true\)/);
  assert.match(menuBody, /teardownHooks\(true, true\)/);
});

test("landing menu heartbeat keeps the relay alive while waiting for input", () => {
  const landingSource = readFileSync(new URL("../landingMenu.ts", import.meta.url), "utf8");
  assert.match(landingSource, /const menuHeartbeat = setInterval\(\(\) => \{\s*void fetchSessions\(\);\s*\}, 10_000\)/);
  assert.match(landingSource, /clearInterval\(menuHeartbeat\)/);
});

test("prune command cleans marker state without starting the relay", () => {
  assert.match(cliSource, /case "prune":/);
  assert.match(cliSource, /pruneSessionMarkerFiles/);
  const pruneCase = cliSource.slice(cliSource.indexOf('case "prune":'), cliSource.indexOf('case "setup":'));
  assert.doesNotMatch(pruneCase, /ensureServerRunning|startServer/);
});

test("setup hook commands pass canonical hook event labels", () => {
  // commandFor lives in hookManager.ts since Phase 4 extraction
  const hookSource = readFileSync(new URL("../hookManager.ts", import.meta.url), "utf8");
  assert.match(hookSource, /export function commandFor\([^)]*hookEvent/);
  assert.match(hookSource, /SESSIONBAR_HOOK_EVENT=\$\{shellEscape\(hookEvent\)\}/);
  assert.ok(hookSource.includes('commandFor("codex", "Codex", reportPath, "working", "\\"${CODEX_TOOL_NAME:-Working}\\"", "PreToolUse")'));
  assert.ok(hookSource.includes('commandFor("codex", "Codex", reportPath, "blocked", "\'Waiting for permission\'", "PermissionRequest")'));
});
