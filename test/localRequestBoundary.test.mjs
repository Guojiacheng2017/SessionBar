import assert from "node:assert/strict";
import test from "node:test";
import { browserOriginAllowed, isLoopbackHost, localRequestBoundary } from "../dist/server/localRequestBoundary.js";

test("local browser requests must use the same origin including the runtime port", () => {
  assert.equal(browserOriginAllowed(undefined, "127.0.0.1:60073", "http"), true);
  assert.equal(browserOriginAllowed("http://127.0.0.1:60073", "127.0.0.1:60073", "http"), true);
  for (const origin of ["http://127.0.0.1:60388", "https://127.0.0.1:60073", "https://attacker.invalid", "null", "%"]) {
    assert.equal(browserOriginAllowed(origin, "127.0.0.1:60073", "http"), false);
  }
});

test("LAN and rebinding hostnames are not trusted loopback names", () => {
  for (const host of ["localhost", "127.0.0.1", "::1", "[::1]"]) assert.equal(isLoopbackHost(host), true);
  for (const host of ["attacker.invalid", "192.168.1.2", "127.0.0.1.attacker.invalid"]) assert.equal(isLoopbackHost(host), false);
});

test("browser boundary rejects rebinding and cross-site requests before route handling", () => {
  for (const request of [
    { hostname: "attacker.invalid", headers: {}, expected: 421 },
    { hostname: "127.0.0.1", headers: { "sec-fetch-site": "cross-site" }, expected: 403 },
    { hostname: "127.0.0.1", headers: { origin: "https://attacker.invalid" }, expected: 403 },
  ]) {
    let status;
    let continued = false;
    const headers = new Map();
    const response = { setHeader: (key, value) => headers.set(key, value), status: value => { status = value; return response; }, json: () => {} };
    localRequestBoundary({ ...request, protocol: "http", get: () => "127.0.0.1:60073" }, response, () => { continued = true; });
    assert.equal(status, request.expected);
    assert.equal(continued, false);
    assert.equal(headers.get("X-Frame-Options"), "DENY");
  }
});
