import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { detectHarnessAvailability, MAINSTREAM_HARNESSES, isSessionbarCommandFor, dedupeSessionbarHooks } from "../dist/hooks/hookManager.js";
import { createRainbow, landingActions, logoLines, parseLandingKeys } from "../dist/cli/landingMenu.js";

const cliSource = readFileSync(new URL("../src/cli/cli.ts", import.meta.url), "utf8");

test("landing resolves its display port after readiness instead of capturing startup state", () => {
  const source = readFileSync(new URL("../src/cli/landingMenu.ts", import.meta.url), "utf8");
  assert.match(source, /const renderLanding = async \(\) => \{\s*setMenuScreen\(true\);\s*const port = getPort\(\)/);
  assert.match(cliSource, /teardownHooks: releaseAppHooks,\s*getPort: refreshRuntimePort/);
});

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

test("start replaces a healthy relay when its build id differs", () => {
  assert.match(cliSource, /health\.build_id/);
  assert.match(cliSource, /currentBuildId/);
  assert.match(cliSource, /build.*restart|restart.*build/i);
});

test("automatic build replacement preserves installed hooks", () => {
  assert.doesNotMatch(functionBody("restartServerProcess"), /teardownHooks/);
  const serverSource = readFileSync(new URL("../src/server/server.ts", import.meta.url), "utf8");
  const cleanup = serverSource.slice(serverSource.indexOf("function cleanup"), serverSource.indexOf("const sessions"));
  assert.doesNotMatch(cleanup, /remove.*Hooks/);
});

test("a live relay gets bounded health retries before it can be restarted", () => {
  const serviceBody = functionBody("ensureServerRunning");
  const retry = serviceBody.indexOf("if (await waitForReady(4)) return true;");
  const restart = serviceBody.indexOf("await restartServerProcess(quiet)");
  assert.notEqual(retry, -1);
  assert.ok(restart > retry, "bounded health retry must happen before restart");
});

test("explicit restart waits for the previous relay before starting with the current environment", () => {
  const restartCase = cliSource.slice(cliSource.indexOf('case "restart":'), cliSource.indexOf('case "prune":'));
  assert.match(restartCase, /await restartServerProcess\(\).*await startServer\(\).*await waitForReady\(\)/);
  assert.doesNotMatch(restartCase, /teardownHooks/);
  const startBody = functionBody("startServer");
  assert.match(startBody, /\.\.\.process\.env/);
  assert.match(startBody, /await waitForChildSpawn\(proc\)/);
  assert.match(cliSource, /SESSIONBAR_NODE_EXEC_PATH: process\.execPath/);
});

test("attached clients report startup environment differences without restarting the relay", () => {
  const readyBody = functionBody("waitForReady");
  assert.match(readyBody, /readRelayConfigMatch/);
  assert.match(readyBody, /warnedStartupEnvironment/);
  assert.match(readyBody, /use sessionbar restart/);
  assert.doesNotMatch(readyBody, /restartServerProcess/);
});

test("health deadlines do not apply to the long-lived SSE request", () => {
  assert.match(functionBody("fetchHealth"), /fetchRelayHealth/);
  assert.match(functionBody("waitForReady"), /fetchRelayHealth/);
  assert.doesNotMatch(functionBody("relayFetch"), /timeout|AbortController|setTimeout/);
  assert.match(cliSource, /sessions\/stream`, \{ signal \}/);
});

test("an active TUI restarts the relay once after a connection failure", () => {
  const fetchBody = cliSource.slice(
    cliSource.indexOf("async function fetchSessions"),
    cliSource.indexOf("async function fetchSystem"),
  );
  assert.match(fetchBody, /requestSessions/);
  assert.match(fetchBody, /ensureServerRunning\(true\)/);
  assert.match(fetchBody, /return requestSessions\(\)/);
});

test("interactive app readiness is the hook registration boundary", () => {
  assert.match(cliSource, /async function ensureAppRunning\s*\(/);
  const appBody = functionBody("ensureAppRunning");
  assert.match(appBody, /ensureServerRunning/);
  assert.match(appBody, /injectHooksOnServerReady/);
});

test("interactive hook registration covers every supported harness", () => {
  const hookSource = readFileSync(new URL("../src/hooks/hookManager.ts", import.meta.url), "utf8");
  const start = hookSource.indexOf("export function injectHooksOnServerReady");
  const end = hookSource.indexOf("export async function setupHooks", start);
  const body = hookSource.slice(start, end);
  for (const setup of ["setupClaudeHooks", "setupCodexHooks", "setupGeminiHooks", "setupCopilotHooks", "setupCursorHooks", "setupCodeBuddyHooks", "setupPiHooks", "setupKimiCodeHooks", "setupZCodeHooks"]) {
    assert.match(body, new RegExp(`${setup}\\(global, reportPath\\)`));
  }
});

test("harness availability covers every supported local harness", () => {
  assert.deepEqual(MAINSTREAM_HARNESSES.map(harness => harness.id), ["kimi-code", "zcode", "dsh", "claude", "codex", "gemini", "copilot", "cursor", "pi", "codebuddy-cli", "workbuddy-desktop"]);
  const rows = detectHarnessAvailability();
  assert.equal(rows.length, MAINSTREAM_HARNESSES.length);
  assert.ok(rows.every(row => row.supported === true));
  assert.ok(rows.every(row => typeof row.available === "boolean"));
  assert.ok(rows.every(row => row.kind === "installed"));
});

test("CodeBuddy hook matching handles quoted report paths", () => {
  assert.equal(isSessionbarCommandFor("SESSIONBAR_AGENT=codebuddy '/tmp/report.sh' working", "codebuddy"), true);
  assert.equal(isSessionbarCommandFor("SESSIONBAR_AGENT=workbuddy '/tmp/report.sh' working", "codebuddy"), false);
});

test("duplicate CodeBuddy hook entries are reduced to one", () => {
  const config = { hooks: { SessionStart: [
    { hooks: [{ command: "SESSIONBAR_AGENT=codebuddy '/tmp/report.sh' working" }] },
    { hooks: [{ command: "SESSIONBAR_AGENT=codebuddy '/tmp/report.sh' working" }] },
  ] } };
  assert.equal(dedupeSessionbarHooks(config, "codebuddy"), 1);
  assert.equal(config.hooks.SessionStart.length, 1);
});

test("WorkBuddy Desktop availability is distinct from CodeBuddy CLI", () => {
  const rows = detectHarnessAvailability();
  const cli = rows.find(row => row.id === "codebuddy-cli");
  const desktop = rows.find(row => row.id === "workbuddy-desktop");
  assert.ok(cli && desktop);
  assert.notEqual(cli.id, desktop.id);
  assert.match(desktop.configPath, /\.workbuddy$/);
});

test("harness availability command is read-only", () => {
  assert.match(cliSource, /case "harnesses":/);
  assert.match(cliSource, /detectHarnessAvailability\(\)/);
  const harnessCase = cliSource.slice(cliSource.indexOf('case "harnesses":'), cliSource.indexOf('case "status":'));
  assert.doesNotMatch(harnessCase, /ensureServerRunning|startServer|injectHooksOnServerReady|setupHooks/);
});

test("status and start paths do not register hooks", () => {
  const statusBody = functionBody("status");
  assert.doesNotMatch(statusBody, /injectHooksOnServerReady|setupClaudeHooks/);
  const startCase = cliSource.slice(cliSource.indexOf('case "start":'), cliSource.indexOf('case "stop":'));
  assert.doesNotMatch(startCase, /injectHooksOnServerReady|setupClaudeHooks/);
});

test("landing menu exit releases its app client without immediately killing the relay", () => {
  // runLandingMenu lives in landingMenu.ts since Phase 6 extraction
  const landingSource = readFileSync(new URL("../src/cli/landingMenu.ts", import.meta.url), "utf8");
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
  assert.match(menuBody, /teardownHooks\(true, true\)/);
  const releaseStart = cliSource.indexOf("function releaseAppHooks");
  const releaseEnd = cliSource.indexOf("function isBunRuntime", releaseStart);
  const releaseBody = cliSource.slice(releaseStart, releaseEnd);
  assert.match(releaseBody, /releaseAppClient/);
  assert.match(releaseBody, /lifecycle\/unobserved/);
  assert.doesNotMatch(releaseBody, /stopServer\(true\)/);
});

test("monitor always releases its app client when rendering fails", () => {
  const mainSource = cliSource.slice(cliSource.indexOf("async function main"));
  const monitorCase = mainSource.slice(mainSource.indexOf('case "watch":'), mainSource.indexOf("default:"));
  assert.match(monitorCase, /try\s*{\s*await watch\(cmd === "providers" \|\| cmd === "agents" \? cmd : monitorViewArg\(\)\)/);
  assert.match(monitorCase, /finally\s*{\s*await releaseAppHooks\(true, true\)/);
});

test("the final CLI client requests a grace period instead of stopping the relay", () => {
  const releaseBody = functionBody("releaseAppHooks");
  assert.match(releaseBody, /releaseAppClient\(HOME\)/);
  assert.match(releaseBody, /relayFetch\(`\$\{apiBase\(\)\}\/lifecycle\/unobserved`, \{ method: "POST" \}\)/);
  assert.doesNotMatch(releaseBody, /stopServer/);
});

test("landing renders the current dynamic relay port", () => {
  const landingSource = readFileSync(new URL("../src/cli/landingMenu.ts", import.meta.url), "utf8");
  assert.match(landingSource, /getPort:\s*\(\)\s*=>\s*number/);
  assert.match(landingSource, /const port = getPort\(\)/);
  assert.match(cliSource, /getPort:\s*refreshRuntimePort/);
});

test("landing menu does not poll sessions while waiting for input", () => {
  const landingSource = readFileSync(new URL("../src/cli/landingMenu.ts", import.meta.url), "utf8");
  assert.doesNotMatch(landingSource, /menuHeartbeat|setInterval/);
});

test("landing keeps its last successful sessions when refresh fails", () => {
  const landingSource = readFileSync(new URL("../src/cli/landingMenu.ts", import.meta.url), "utf8");
  assert.match(landingSource, /if \(!result\.error\) menuSessions = result\.sessions/);
  assert.doesNotMatch(landingSource, /menuSessions = result\.error \? \[\] : result\.sessions/);
});

test("landing web status is informational with a direct w shortcut", () => {
  assert.deepEqual(landingActions().map(action => action.key), ["1", "2", "3", "4"]);
  assert.deepEqual(parseLandingKeys("wW"), ["w", "w"]);
  const landingSource = readFileSync(new URL("../src/cli/landingMenu.ts", import.meta.url), "utf8");
  assert.match(landingSource, /Web dashboard/);
  assert.match(landingSource, /launchWeb/);
  assert.match(landingSource, /W web/);
  assert.match(cliSource, /launchWeb: openWebDashboard/);
});

test("landing renders the script brand while keeping narrow NO_COLOR output safe", () => {
  const large = logoLines(76, createRainbow(false), "");
  assert.ok(large.length >= 8 && large.length <= 12);
  assert.equal(large.join("\n").includes("\u001b["), false);
  assert.match(large.join("\n"), /AI CLI Session Monitor/);

  const narrow = logoLines(64, createRainbow(false), "");
  assert.ok(narrow.length <= 4);
  assert.equal(narrow.join("\n").includes("\u001b["), false);
  assert.match(narrow.join("\n"), /SessionBar/);
});

test("opening the web dashboard reuses the current relay", () => {
  const openWebBody = functionBody("openWebDashboard");
  assert.match(openWebBody, /ensureServerRunning/);
  assert.doesNotMatch(openWebBody, /stopServer|startServer/);

  const webCase = cliSource.slice(cliSource.indexOf('case "web":'), cliSource.indexOf('case "start":'));
  assert.match(webCase, /ensureServerRunning/);
  assert.doesNotMatch(webCase, /stopServer|startServer/);
});

test("landing menu exposes Settings as an action", () => {
  const settings = landingActions().find(action => action.key === "4");
  assert.deepEqual(settings, {
    key: "4",
    label: "settings",
    desc: "Configure SessionBar",
    enabled: true,
  });
  assert.deepEqual(parseLandingKeys("4"), ["4"]);
  const landingSource = readFileSync(new URL("../src/cli/landingMenu.ts", import.meta.url), "utf8");
  assert.match(landingSource, /launchSettings/);
  assert.match(readFileSync(new URL("../src/cli/cli.ts", import.meta.url), "utf8"), /Type ENABLE to allow real reset-card consumption/);
});

test("prune command cleans marker state without starting the relay", () => {
  assert.match(cliSource, /case "prune":/);
  assert.match(cliSource, /pruneSessionMarkerFiles/);
  const pruneCase = cliSource.slice(cliSource.indexOf('case "prune":'), cliSource.indexOf('case "setup":'));
  assert.doesNotMatch(pruneCase, /ensureServerRunning|startServer/);
});

test("setup hook commands pass canonical hook event labels", () => {
  // commandFor lives in hookManager.ts since Phase 4 extraction
  const hookSource = readFileSync(new URL("../src/hooks/hookManager.ts", import.meta.url), "utf8");
  assert.match(hookSource, /export function commandFor\([^)]*hookEvent/);
  assert.match(hookSource, /SESSIONBAR_HOOK_EVENT=\$\{shellEscape\(hookEvent\)\}/);
  assert.ok(hookSource.includes('commandFor("codex", "Codex", reportPath, "working", "\\"${CODEX_TOOL_NAME:-Working}\\"", "PreToolUse")'));
  assert.ok(hookSource.includes('commandFor("codex", "Codex", reportPath, "blocked", "\'Waiting for permission\'", "PermissionRequest")'));
});

test("monitor fetches structurally valid system state from the independent endpoint", () => {
  const fetchSystemBody = functionBody("fetchSystem");
  assert.match(fetchSystemBody, /relayFetch\(`\$\{apiBase\(\)\}\/system\/live`\)/);
  assert.match(fetchSystemBody, /data\.system/);
  assert.match(fetchSystemBody, /isSystemEfficiencySnapshot/);
  assert.match(fetchSystemBody, /throw new Error\("invalid system response"\)/);
});

test("monitor settles session and system fetches independently", () => {
  const monitorSource = readFileSync(new URL("../src/tui/openTuiMonitor.ts", import.meta.url), "utf8");
  assert.match(monitorSource, /createIndependentMonitorRefresh/);
  assert.doesNotMatch(monitorSource, /Promise\.allSettled\(\[\s*opts\.fetchSessions\(\),\s*opts\.fetchSystem/);
  assert.match(cliSource, /fetchSystem(?:,|:)/);
});

test("monitor close tears down the active SSE transport", () => {
  const monitorSource = readFileSync(new URL("../src/tui/openTuiMonitor.ts", import.meta.url), "utf8");
  assert.match(monitorSource, /opts\.closeTransport\?\.\(\)/);
  assert.match(cliSource, /closeTransport:\s*closeSSETransport/);
});

test("monitor routes interval and manual refresh through single-flight controllers", () => {
  const monitorSource = readFileSync(new URL("../src/tui/openTuiMonitor.ts", import.meta.url), "utf8");
  assert.match(monitorSource, /const refreshMonitor = createIndependentMonitorRefresh/);
  assert.match(monitorSource, /const refreshSessions = createSingleFlightRefresh/);
  assert.match(monitorSource, /const refreshSystem = createSingleFlightRefresh/);
  assert.match(monitorSource, /const refreshProviders = createSingleFlightRefresh/);
  assert.match(monitorSource, /refreshMonitor\("manual"\)/);
  assert.match(monitorSource, /refreshMonitor\("poll"\)/);
  assert.match(monitorSource, /refreshProviders\("manual"\)/);
  assert.match(monitorSource, /refreshProviders\("poll"\)/);
});
