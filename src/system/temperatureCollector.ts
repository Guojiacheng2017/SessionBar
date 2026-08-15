import { execFile as systemExecFile } from "node:child_process";
import { existsSync } from "node:fs";

export interface TemperatureReadings {
  device_temperature_celsius?: number;
  battery_temperature_celsius?: number;
}

interface ExecFileOptions {
  encoding: "utf8";
  timeout: number;
  maxBuffer: number;
}

export type TemperatureExecFile = (
  file: string,
  args: string[],
  options: ExecFileOptions,
  callback: (error: Error | null, stdout: string) => void,
) => void;

export interface TemperatureCollectorOptions {
  platform?: NodeJS.Platform;
  now?: () => number;
  refreshMs?: number;
  macmonPath?: string | null;
  ioregPath?: string;
  execFile?: TemperatureExecFile;
}

const DEFAULT_REFRESH_MS = 30_000;
const MACMON_ARGS = ["pipe", "-s", "1", "-i", "1000"];
const MACMON_OPTIONS: ExecFileOptions = {
  encoding: "utf8",
  timeout: 5_000,
  maxBuffer: 256 * 1024,
};
const IOREG_ARGS = ["-l", "-r", "-c", "AppleSmartBattery", "-w", "0"];
const IOREG_OPTIONS: ExecFileOptions = {
  encoding: "utf8",
  timeout: 1_500,
  maxBuffer: 128 * 1024,
};

function plausibleTemperature(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= maximum;
}

export function parseMacmonTemperature(stdout: string): number | undefined {
  const lines = stdout.trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const payload = JSON.parse(line) as { temp?: { cpu_temp_avg?: unknown } };
      const value = payload.temp?.cpu_temp_avg;
      if (plausibleTemperature(value, 125)) return value;
    } catch {
      // macmon writes one JSON object per line; ignore non-JSON diagnostics.
    }
  }
  return undefined;
}

export function parseBatteryTemperature(stdout: string): number | undefined {
  const match = /^\s*"Temperature"\s*=\s*(\d+)\s*$/m.exec(stdout);
  if (!match) return undefined;
  const celsius = Number(match[1]) / 100;
  return plausibleTemperature(celsius, 100) ? celsius : undefined;
}

function defaultExecFile(
  file: string,
  args: string[],
  options: ExecFileOptions,
  callback: (error: Error | null, stdout: string) => void,
): void {
  systemExecFile(file, args, options, (error, stdout) => callback(error, String(stdout ?? "")));
}

function commandOutput(
  execFile: TemperatureExecFile,
  file: string | undefined,
  args: string[],
  options: ExecFileOptions,
): Promise<string | undefined> {
  if (!file) return Promise.resolve(undefined);
  return new Promise(resolve => {
    execFile(file, args, options, (error, stdout) => resolve(error ? undefined : stdout));
  });
}

function installedMacmonPath(configured: string | null | undefined): string | undefined {
  if (typeof configured === "string" && configured.length > 0) return configured;
  if (configured === null) return undefined;
  const candidates = [
    process.env.SESSIONBAR_MACMON_PATH,
    "/opt/homebrew/bin/macmon",
    "/usr/local/bin/macmon",
  ];
  return candidates.find(candidate => typeof candidate === "string" && existsSync(candidate));
}

function hasTemperature(readings: TemperatureReadings): boolean {
  return readings.device_temperature_celsius !== undefined
    || readings.battery_temperature_celsius !== undefined;
}

export function createTemperatureCollector(
  options: TemperatureCollectorOptions = {},
): () => Promise<TemperatureReadings | undefined> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return async () => undefined;

  const now = options.now ?? (() => Date.now());
  const refreshMs = Math.max(1_000, Math.floor(options.refreshMs ?? DEFAULT_REFRESH_MS));
  const execFile = options.execFile ?? defaultExecFile;
  const macmonPath = installedMacmonPath(options.macmonPath);
  const ioregPath = options.ioregPath ?? "/usr/sbin/ioreg";
  let lastAttemptAt: number | undefined;
  let cached: TemperatureReadings = {};
  let inFlight: Promise<TemperatureReadings | undefined> | undefined;

  return async () => {
    if (inFlight) return inFlight;
    const currentTime = now();
    const elapsed = lastAttemptAt === undefined ? undefined : currentTime - lastAttemptAt;
    if (elapsed !== undefined && elapsed >= 0 && elapsed < refreshMs) {
      return hasTemperature(cached) ? { ...cached } : undefined;
    }

    lastAttemptAt = currentTime;
    inFlight = (async () => {
      const [macmonOutput, batteryOutput] = await Promise.all([
        commandOutput(execFile, macmonPath, MACMON_ARGS, MACMON_OPTIONS),
        commandOutput(execFile, ioregPath, IOREG_ARGS, IOREG_OPTIONS),
      ]);
      const deviceTemperature = macmonOutput === undefined
        ? undefined
        : parseMacmonTemperature(macmonOutput);
      const batteryTemperature = batteryOutput === undefined
        ? undefined
        : parseBatteryTemperature(batteryOutput);
      if (deviceTemperature !== undefined) cached.device_temperature_celsius = deviceTemperature;
      if (batteryTemperature !== undefined) cached.battery_temperature_celsius = batteryTemperature;
      return hasTemperature(cached) ? { ...cached } : undefined;
    })();

    try {
      return await inFlight;
    } finally {
      inFlight = undefined;
    }
  };
}
