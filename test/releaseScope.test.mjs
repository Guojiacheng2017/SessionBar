import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { LANDING_COMMANDS } from "../dist/cli/landingCommand.js";

test("v1.1.0 omits unfinished runtime modules and entry points", () => {
  const root = new URL("../", import.meta.url);
  for (const path of ["src/auth", "src/cost", "src/remote", "src/providers/providerCredentials.ts",
    "public/settings.html", "public/devices.html", "public/pair.html",
    "dist/auth", "dist/cost", "dist/remote", "dist/web/opticalPairing.js"]) {
    assert.equal(existsSync(new URL(path, root)), false, path);
  }
  assert.ok(!LANDING_COMMANDS.includes("pair"));
  assert.ok(!LANDING_COMMANDS.includes("devices"));
  const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  assert.equal(manifest.version, "1.1.0");
  assert.equal(manifest.dependencies.express, "^5.2.1");
});
