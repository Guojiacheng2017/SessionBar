import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pruneSessionMarkerFiles, removeSessionMarkerFiles, scopedSessionId } from "../dist/sessions/sessionMarkers.js";

test("removes the marker file for a timed-out session id", () => {
  const dir = mkdtempSync(join(tmpdir(), "sessionbar-markers-"));
  try {
    writeFileSync(join(dir, "sessionbar-id-codex-project-notty-123"), "codex-demo__Vision-Dash\n");
    writeFileSync(join(dir, "sessionbar-id-claude-project-notty-999"), "claude-demo__Vision-Dash\n");

    const removed = removeSessionMarkerFiles(dir, "codex-demo__Vision-Dash");

    assert.deepEqual(removed, ["sessionbar-id-codex-project-notty-123"]);
    assert.throws(() => readFileSync(join(dir, "sessionbar-id-codex-project-notty-123")));
    assert.equal(readFileSync(join(dir, "sessionbar-id-claude-project-notty-999"), "utf8"), "claude-demo__Vision-Dash\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removes legacy duplicate markers by matching their recovered scoped session id", () => {
  const dir = mkdtempSync(join(tmpdir(), "sessionbar-markers-"));
  try {
    const file = "sessionbar-id-codex-project-notty-456";
    const stored = "codex-demo__Vision-Dash";
    const recovered = scopedSessionId(stored, file);
    writeFileSync(join(dir, file), `${stored}\n`);

    const removed = removeSessionMarkerFiles(dir, recovered);

    assert.deepEqual(removed, [file]);
    assert.throws(() => readFileSync(join(dir, file)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prunes marker files older than the configured heartbeat age", () => {
  const dir = mkdtempSync(join(tmpdir(), "sessionbar-markers-"));
  try {
    const oldFile = join(dir, "sessionbar-id-codex-project-notty-old");
    const freshFile = join(dir, "sessionbar-id-codex-project-notty-fresh");
    writeFileSync(oldFile, "codex-old__Vision-Dash\n");
    writeFileSync(freshFile, "codex-fresh__Vision-Dash\n");
    const now = 1_700_000_000_000;
    utimesSync(oldFile, new Date(now - 600_000), new Date(now - 600_000));
    utimesSync(freshFile, new Date(now - 60_000), new Date(now - 60_000));

    const result = pruneSessionMarkerFiles(dir, { now, maxAgeMs: 300_000 });

    assert.deepEqual(result.removed.map(item => item.file), ["sessionbar-id-codex-project-notty-old"]);
    assert.equal(existsSync(oldFile), false);
    assert.equal(existsSync(freshFile), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
