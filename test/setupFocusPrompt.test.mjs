import assert from "node:assert/strict";
import test from "node:test";
import { setupFocusFromKey } from "../dist/cli/setupFocusPrompt.js";

test("setup focus keys distinguish local, global, cancel and unrelated input", () => {
  assert.equal(setupFocusFromKey("l"), "local");
  assert.equal(setupFocusFromKey("L"), "local");
  assert.equal(setupFocusFromKey("g"), "global");
  assert.equal(setupFocusFromKey("G"), "global");
  assert.equal(setupFocusFromKey("\x1b"), "cancel");
  assert.equal(setupFocusFromKey("\u0003"), "cancel");
  assert.equal(setupFocusFromKey("x"), undefined);
});
