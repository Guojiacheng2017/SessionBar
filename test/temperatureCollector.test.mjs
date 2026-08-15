import assert from "node:assert/strict";
import test from "node:test";
import {
  createTemperatureCollector,
  parseBatteryTemperature,
  parseMacmonTemperature,
} from "../dist/system/temperatureCollector.js";

test("parses a plausible CPU/SoC average from macmon JSON", () => {
  assert.equal(parseMacmonTemperature(JSON.stringify({ temp: { cpu_temp_avg: 70.635 } })), 70.635);
  assert.equal(parseMacmonTemperature(JSON.stringify({ temp: { cpu_temp_avg: null } })), undefined);
  assert.equal(parseMacmonTemperature(JSON.stringify({ temp: { cpu_temp_avg: 140 } })), undefined);
  assert.equal(parseMacmonTemperature("not json"), undefined);
});

test("parses AppleSmartBattery temperature in hundredths of a degree", () => {
  const output = [
    "+-o AppleSmartBattery",
    "    {",
    '      "Temperature" = 3093',
    '      "VirtualTemperature" = 3609',
    "    }",
  ].join("\n");

  assert.equal(parseBatteryTemperature(output), 30.93);
  assert.equal(parseBatteryTemperature('"Temperature" = 0'), undefined);
  assert.equal(parseBatteryTemperature('"Temperature" = 12000'), undefined);
  assert.equal(parseBatteryTemperature("no battery"), undefined);
});

test("caches temperature commands for thirty seconds and preserves partial results", async () => {
  let now = 1_000;
  let round = 0;
  const calls = [];
  const collector = createTemperatureCollector({
    platform: "darwin",
    now: () => now,
    refreshMs: 30_000,
    macmonPath: "/test/macmon",
    ioregPath: "/test/ioreg",
    execFile(file, args, options, callback) {
      calls.push({ file, args, options });
      if (file === "/test/macmon") {
        if (round === 0) callback(null, JSON.stringify({ temp: { cpu_temp_avg: 70.6 } }));
        else callback(new Error("macmon failed"), "");
        return;
      }
      callback(null, `"Temperature" = ${round === 0 ? 3090 : 3200}`);
    },
  });

  assert.deepEqual(await collector(), {
    device_temperature_celsius: 70.6,
    battery_temperature_celsius: 30.9,
  });
  assert.equal(calls.length, 2);

  now = 30_999;
  assert.deepEqual(await collector(), {
    device_temperature_celsius: 70.6,
    battery_temperature_celsius: 30.9,
  });
  assert.equal(calls.length, 2);

  round = 1;
  now = 31_000;
  assert.deepEqual(await collector(), {
    device_temperature_celsius: 70.6,
    battery_temperature_celsius: 32,
  });
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0], {
    file: "/test/macmon",
    args: ["pipe", "-s", "1", "-i", "1000"],
    options: { encoding: "utf8", timeout: 5_000, maxBuffer: 256 * 1024 },
  });
  assert.deepEqual(calls[1], {
    file: "/test/ioreg",
    args: ["-l", "-r", "-c", "AppleSmartBattery", "-w", "0"],
    options: { encoding: "utf8", timeout: 1_500, maxBuffer: 128 * 1024 },
  });
});

test("does not execute temperature commands outside macOS", async () => {
  let called = false;
  const collector = createTemperatureCollector({
    platform: "linux",
    execFile() {
      called = true;
    },
  });

  assert.equal(await collector(), undefined);
  assert.equal(called, false);
});

test("shares an in-flight temperature refresh across concurrent callers", async () => {
  const callbacks = [];
  const collector = createTemperatureCollector({
    platform: "darwin",
    macmonPath: "/test/macmon",
    ioregPath: "/test/ioreg",
    execFile(_file, _args, _options, callback) {
      callbacks.push(callback);
    },
  });

  const first = collector();
  const second = collector();
  assert.equal(callbacks.length, 2);
  callbacks[0](null, JSON.stringify({ temp: { cpu_temp_avg: 61.2 } }));
  callbacks[1](null, '"Temperature" = 3080');
  assert.deepEqual(await first, {
    device_temperature_celsius: 61.2,
    battery_temperature_celsius: 30.8,
  });
  assert.deepEqual(await second, await first);
});
