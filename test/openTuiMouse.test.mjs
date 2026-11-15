import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
test("native Monitor mouse controls support padded clicks and hover without breaking keyboard navigation", async () => {
    const result = await promisify(execFile)("bun", [fileURLToPath(new URL("./fixtures/monitorMouse.mjs", import.meta.url))], {
        cwd: fileURLToPath(new URL("../", import.meta.url)), env: process.env, timeout: 30_000, maxBuffer: 1_000_000,
    });
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.viewports, ["140x40", "80x24", "48x24", "40x24", "40x20"]);
    assert.ok(report.checks.includes("refresh during click"));
    assert.ok(report.checks.includes("details wheel"));
});
test("native session details keep their frame and scroll extent bounded across stacked and short layouts", async () => {
    const result = await promisify(execFile)("bun", [fileURLToPath(new URL("./fixtures/monitorDetails.mjs", import.meta.url)), "layout"], {
        cwd: fileURLToPath(new URL("../", import.meta.url)), env: process.env, timeout: 15_000, maxBuffer: 1_000_000,
    });
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.viewports, ["110x50", "110x51", "118x60", "80x40", "140x40", "80x24", "48x24", "40x20"]);
});
test("native details and provider drag selections have visible persistent highlights", async () => {
    const result = await promisify(execFile)("bun", [fileURLToPath(new URL("./fixtures/monitorDetails.mjs", import.meta.url)), "selection"], {
        cwd: fileURLToPath(new URL("../", import.meta.url)), env: process.env, timeout: 15_000, maxBuffer: 1_000_000,
    });
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.viewports, ["140x40", "110x50", "80x40", "80x24"]);
});
test("native Raw details retain long wrapped fields and an accessible final value", async () => {
    const result = await promisify(execFile)("bun", [fileURLToPath(new URL("./fixtures/monitorDetails.mjs", import.meta.url)), "raw"], {
        cwd: fileURLToPath(new URL("../", import.meta.url)), env: process.env, timeout: 15_000, maxBuffer: 1_000_000,
    });
    assert.deepEqual(JSON.parse(result.stdout).viewports, ["110x50", "80x24", "40x20"]);
});
