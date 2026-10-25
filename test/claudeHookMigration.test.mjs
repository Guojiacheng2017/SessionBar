import assert from "node:assert/strict";
import test from "node:test";
import { removeLegacyClaudeSessionbarHooks } from "../dist/hooks/hookManager.js";

test("legacy bare report hooks are removed while canonical and third-party hooks remain", () => {
  const hooks = {
    SessionStart: [
      { matcher: "", hooks: [{ type: "command", command: "/repo/report.sh working 'Working'" }] },
      { matcher: "", hooks: [{ type: "command", command: "SESSIONBAR_AGENT=claude SESSIONBAR_SESSION_TYPE='Claude Code' SESSIONBAR_HOOK_EVENT='SessionStart' '/repo/report.sh' working 'Working'" }] },
      { matcher: "", hooks: [{ type: "command", command: "/third-party/hook.sh" }] },
      { matcher: "", hooks: [{ type: "command", command: "/third-party/report.sh working custom" }] },
    ],
    Stop: [{ matcher: "", hooks: [
      { type: "command", command: "/repo/report.sh idle 'Ready'" },
      { type: "command", command: "/third-party/stop.sh" },
    ] }],
  };

  assert.equal(removeLegacyClaudeSessionbarHooks(hooks, "/repo/report.sh"), 2);
  assert.equal(hooks.SessionStart.length, 3);
  assert.match(hooks.SessionStart[0].hooks[0].command, /SESSIONBAR_AGENT=claude/);
  assert.equal(hooks.Stop[0].hooks.length, 1);
  assert.equal(hooks.Stop[0].hooks[0].command, "/third-party/stop.sh");
  assert.equal(hooks.SessionStart[2].hooks[0].command, "/third-party/report.sh working custom");
});

test("legacy cleanup recognizes quoted owned paths but not text that merely mentions them", () => {
  const hooks = { Stop: [{ hooks: [
    { command: "'/repo/Session Bar/report.sh' idle Ready" },
    { command: '"/repo/Session Bar/report.sh" idle Ready' },
    { command: "printf '/repo/Session Bar/report.sh'" },
    { command: "'/repo/Session Bar/report.sh.other' idle Ready" },
  ] }] };
  assert.equal(removeLegacyClaudeSessionbarHooks(hooks, "/repo/Session Bar/report.sh"), 2);
  assert.equal(hooks.Stop[0].hooks.length, 2);
});
