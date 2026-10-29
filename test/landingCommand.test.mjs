import assert from "node:assert/strict";
import test from "node:test";
const commands = await import("../dist/cli/landingCommand.js").catch(() => ({}));

test("landing resolves built-ins and does not execute arbitrary commands or extra arguments", () => {
  assert.equal(typeof commands.resolveLandingCommand, "function");
  for (const [input, expected] of [["monitor", "monitor"], ["sessions", "monitor"], ["providers", "providers"], ["agents", "agents"], [":status", "status"], ["quit", "quit"], ["w", "web"]]) {
    assert.equal(commands.resolveLandingCommand(input), expected);
  }
  for (const input of ["rm -rf /", "status;quit", "web https://invalid.example", "node x.js", "$(echo x)", "constructor", "__proto__"]) assert.equal(commands.resolveLandingCommand(input), null);
});

test("command editing keeps shortcut letters inside the box", () => {
  assert.equal(typeof commands.LandingCommandInput, "function");
  const editor = new commands.LandingCommandInput();
  assert.deepEqual(editor.feed(":setq"), ["input"]);
  assert.equal(editor.value, "setq");
  assert.equal(editor.active, true);
  editor.feed("\x7fup");
  assert.equal(editor.value, "setup");
  assert.deepEqual(editor.feed("\r"), ["command:setup"]);
  assert.equal(editor.active, false);
});

test("command editing handles cursor movement, completion, history and Escape", () => {
  assert.equal(typeof commands.LandingCommandInput, "function");
  const editor = new commands.LandingCommandInput();
  editor.feed(":stat\t");
  assert.equal(editor.value, "status");
  editor.feed("\r:agents\r:");
  editor.feed("\x1b[A");
  assert.equal(editor.value, "agents");
  editor.feed("\x1b[A");
  assert.equal(editor.value, "status");
  editor.feed("\x1b[C\x7f");
  assert.equal(editor.value, "statu");
  assert.deepEqual(editor.feed("\x1b"), ["input"]);
  assert.equal(editor.active, false);
  assert.equal(editor.value, "");
  editor.feed(":" + "a".repeat(400));
  assert.ok(editor.value.length <= 256);
  assert.ok(editor.display(24).length <= 24);
});
