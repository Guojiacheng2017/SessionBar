import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensurePrivateDirectory, writePrivateState } from "../dist/shared/privateState.js";

test("state writes replace permissive files atomically with owner-only permissions", t => {
  const home = mkdtempSync(join(tmpdir(), "sessionbar-private-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "state.json");
  writeFileSync(path, "old", { mode: 0o644 });
  chmodSync(home, 0o755);
  writePrivateState(path, "new");
  assert.equal(readFileSync(path, "utf8"), "new");
  if (process.platform !== "win32") {
    assert.equal(statSync(home).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
  assert.deepEqual(readdirSync(home), ["state.json"]);
});

test("managed state directories are hardened even when already present", t => {
  const home = mkdtempSync(join(tmpdir(), "sessionbar-private-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  chmodSync(home, 0o755);
  ensurePrivateDirectory(home);
  if (process.platform !== "win32") assert.equal(statSync(home).mode & 0o777, 0o700);
});
