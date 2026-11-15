import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
test("native Providers preserves Web fields and fits wide and narrow terminal sizes", async () => {
    const result = await promisify(execFile)("bun", [fileURLToPath(new URL("./fixtures/providersTui.mjs", import.meta.url))], {
        cwd: fileURLToPath(new URL("../", import.meta.url)), env: process.env, timeout: 15_000, maxBuffer: 1_000_000,
    });
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.viewports, ["150x42", "114x42", "90x30", "80x24", "60x24", "48x24", "48x20", "40x24", "40x20"]);
    assert.ok(report.checks.includes("selection window"));
});
