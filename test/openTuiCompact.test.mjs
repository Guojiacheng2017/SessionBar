import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("compact main monitor keeps keyboard navigation visible across drilldown and resize", t => {
  const result = spawnSync("bun", [new URL("./fixtures/monitorCompact.ts", import.meta.url).pathname], {
    encoding: "utf8", timeout: 20_000,
  });
  if (result.error?.code === "ENOENT") { t.skip("Bun is not installed"); return; }
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout).viewports, ["80x24", "48x24", "40x20"]);
});
