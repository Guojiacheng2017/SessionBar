import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchResetCards } from "../dist/codexWhamAdapter.js";

// mock fetch + mock ~/.codex/auth.json
test("returns cards from wham API", async () => {
  const cards = await fetchResetCards({
    authJsonPath: "/tmp/fake-codex-auth.json",
    fetchImpl: async () => new Response(JSON.stringify([
      { id: "c1", status: "available", expires_at: 1786400000000 },
      { id: "c2", status: "available", expires_at: 1789000000000 },
    ]), { status: 200 }),
  });
  assert.equal(cards.length, 2);
  assert.equal(cards[0].count, 1);
  assert.ok(cards[0].expiresAt > 0);
});

test("401 or missing auth.json → empty array", async () => {
  const cards = await fetchResetCards({
    authJsonPath: "/tmp/nonexistent-auth.json",
    fetchImpl: async () => new Response("{}", { status: 401 }),
  });
  assert.deepEqual(cards, []);
});

test("network error → empty array", async () => {
  const cards = await fetchResetCards({
    authJsonPath: "/tmp/fake-codex-auth.json",
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.deepEqual(cards, []);
});
