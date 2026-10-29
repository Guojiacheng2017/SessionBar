import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const server = readFileSync(new URL("../src/server/server.ts", import.meta.url), "utf8");

test("released routes stay behind the same-origin loopback boundary", () => {
  assert.match(server, /app\.use\(localRequestBoundary\)/);
  assert.match(server, /if \(isDirectRun && !isLoopbackHost\(HOST\)\)/);
  assert.doesNotMatch(server, /SESSIONBAR_ALLOW_INSECURE_LAN|requireDeviceScope/);
});

test("provider cache receives successful results, not retained subscription rows", () => {
  assert.match(server, /aggregateProviders\(freshSubscriptionRows, sessions, providerApiRows\)/);
  assert.doesNotMatch(server, /subscriptionRows = retainRecentProviderRows/);
});

test("disabled provider polling skips both subscription and API polling", () => {
  assert.match(server, /async function collectProviderSignals\(\) \{\s*if \(!PROVIDER_POLL_ENABLED \|\| stopping\) return/);
  assert.match(server, /function startProviderPolling\(\) \{\s*if \(!PROVIDER_POLL_ENABLED\)/);
});

test("Pi events do not copy prompts into task descriptions", () => {
  const hooks = readFileSync(new URL("../src/hooks/hookManager.ts", import.meta.url), "utf8");
  assert.doesNotMatch(hooks, /event\.prompt/);
});
