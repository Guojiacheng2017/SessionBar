import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultSettings, disableAutoConsumeResetCards, readSettings, updateSettings } from "../dist/server/settings.js";

test("settings default auto-consume reset cards to off", () => {
  const home = mkdtempSync(join(tmpdir(), "sessionbar-settings-"));
  try {
    assert.deepEqual(readSettings(home), defaultSettings());
    assert.equal(readSettings(home).autoConsumeResetCards, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("settings persist the auto-consume reset-card toggle", () => {
  const home = mkdtempSync(join(tmpdir(), "sessionbar-settings-"));
  try {
    assert.equal(updateSettings(home, { autoConsumeResetCards: true }).autoConsumeResetCards, true);
    assert.equal(readSettings(home).autoConsumeResetCards, true);
    assert.equal(updateSettings(home, { autoConsumeResetCards: false }).autoConsumeResetCards, false);
    assert.equal(readSettings(home).autoConsumeResetCards, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("successful reset-card consumption disables future auto-consumption", () => {
  const home = mkdtempSync(join(tmpdir(), "sessionbar-settings-"));
  try {
    updateSettings(home, { autoConsumeResetCards: true });
    assert.equal(disableAutoConsumeResetCards(home).autoConsumeResetCards, false);
    assert.equal(readSettings(home).autoConsumeResetCards, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
