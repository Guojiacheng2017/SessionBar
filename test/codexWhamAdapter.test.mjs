import { test, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { fetchResetCards } from "../dist/providers/codexWhamAdapter.js";

// Hermetic auth fixture: written inside the test to os.tmpdir(), never to a
// shared path like /tmp/fake-codex-auth.json (which is absent on a clean
// checkout/CI and would break the suite).
const authPath = join(os.tmpdir(), "codex-wham-test-auth.json");
const missingAuthPath = join(os.tmpdir(), "codex-wham-test-missing-auth.json");

after(() => {
  try { unlinkSync(authPath); } catch { /* already gone */ }
  try { unlinkSync(missingAuthPath); } catch { /* already gone */ }
});

function writeAuthFixture() {
  writeFileSync(authPath, JSON.stringify({
    tokens: { access_token: "test-token-abc" },
    account_id: "acct-123",
  }));
}

// mock fetch + mock ~/.codex/auth.json
test("returns cards from wham API (object shape)", async () => {
  writeAuthFixture();
  const now = Date.now();
  const cards = await fetchResetCards({
    authJsonPath: authPath,
    fetchImpl: async () => new Response(JSON.stringify({
      available_count: 2,
      credits: [
        { expires_at: new Date(now + 86_400_000).toISOString() },
        { expires_at: new Date(now + 2 * 86_400_000).toISOString() },
      ],
    }), { status: 200 }),
  });
  assert.equal(cards.length, 2);
  assert.equal(cards[0].count, 1);
  assert.ok(cards[0].expiresAt > now);
});

test("returns cards from bare-array shape (backward compat)", async () => {
  writeAuthFixture();
  const now = Date.now();
  const cards = await fetchResetCards({
    authJsonPath: authPath,
    fetchImpl: async () => new Response(JSON.stringify([
      { id: "c1", status: "available", expires_at: now + 86_400_000 },
      { id: "c2", status: "available", expires_at: now + 2 * 86_400_000 },
    ]), { status: 200 }),
  });
  assert.equal(cards.length, 2);
  assert.equal(cards[0].count, 1);
  assert.equal(cards[0].id, "c1");
  assert.ok(cards[0].expiresAt > now);
});

test("parses epoch-seconds expires_at", async () => {
  writeAuthFixture();
  const now = Date.now();
  const cards = await fetchResetCards({
    authJsonPath: authPath,
    fetchImpl: async () => new Response(JSON.stringify({
      available_count: 1,
      credits: [{ expires_at: Math.floor((now + 86_400_000) / 1000) }],
    }), { status: 200 }),
  });
  assert.equal(cards.length, 1);
  assert.ok(cards[0].expiresAt > now);
});

test("filters already-expired credits", async () => {
  writeAuthFixture();
  const now = Date.now();
  const cards = await fetchResetCards({
    authJsonPath: authPath,
    fetchImpl: async () => new Response(JSON.stringify({
      available_count: 2,
      credits: [
        { expires_at: new Date(now - 3_600_000).toISOString() },
        { expires_at: new Date(now + 86_400_000).toISOString() },
      ],
    }), { status: 200 }),
  });
  assert.equal(cards.length, 1);
});

test("401 response → empty array", async () => {
  writeAuthFixture();
  const cards = await fetchResetCards({
    authJsonPath: authPath,
    fetchImpl: async () => new Response("{}", { status: 401 }),
  });
  assert.deepEqual(cards, []);
});

test("missing auth.json → empty array", async () => {
  const cards = await fetchResetCards({
    authJsonPath: missingAuthPath,
    fetchImpl: async () => new Response("{}", { status: 200 }),
  });
  assert.deepEqual(cards, []);
});

test("network error → empty array", async () => {
  writeAuthFixture();
  const cards = await fetchResetCards({
    authJsonPath: authPath,
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.deepEqual(cards, []);
});
