import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupCursorHooks, teardownCursorHooks } from "../dist/hooks/hookManager.js";

test("Cursor hooks use the native v1 command-hook contract and install idempotently", () => {
  const previous = process.cwd();
  const root = mkdtempSync(join(tmpdir(), "sessionbar-cursor-hooks-"));
  process.chdir(root);
  try {
    assert.equal(setupCursorHooks(false, "/tmp/report.sh").added, 5);
    assert.equal(setupCursorHooks(false, "/tmp/report.sh").added, 0);
    const config = JSON.parse(readFileSync(join(root, ".cursor", "hooks.json"), "utf8"));
    assert.equal(config.version, 1);
    assert.deepEqual(Object.keys(config.hooks).sort(), [
      "postToolUse", "preToolUse", "sessionEnd", "sessionStart", "stop",
    ]);
    assert.match(config.hooks.sessionStart[0].command, /SESSIONBAR_AGENT=cursor/);
    assert.equal(teardownCursorHooks(false), 5);
  } finally {
    process.chdir(previous);
  }
});
