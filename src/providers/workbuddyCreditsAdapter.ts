import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PlanRow } from "./planTypes.js";

const execFileAsync = promisify(execFile);
const execSqlite = "sqlite3";

export interface WorkBuddyCreditsOpts {
  dbPath?: string;
  sqlitePath?: string;
  balanceCommand?: string;
}

interface UsageRow {
  used?: unknown;
  size?: unknown;
  credit_json?: unknown;
}

/** Read WorkBuddy Desktop's account-wide local credit snapshot without scanning traces. */
export async function fetchWorkBuddyDesktopCredits(opts: WorkBuddyCreditsOpts = {}): Promise<PlanRow | null> {
  const balanceCommand = opts.balanceCommand ?? process.env.SESSIONBAR_WORKBUDDY_BALANCE_COMMAND;
  if (balanceCommand) {
    const balanceRow = await fetchWorkBuddyBalanceCommand(balanceCommand);
    if (balanceRow) return balanceRow;
  }
  const dbPath = opts.dbPath ?? join(homedir(), ".workbuddy", "workbuddy.db");
  if (!existsSync(dbPath)) return null;
  try {
    const result = await execFileAsync(opts.sqlitePath ?? execSqlite, [
      "-json",
      dbPath,
      "SELECT used, size, credit_json FROM session_usage ORDER BY updated_at DESC;",
    ], { maxBuffer: 256 * 1024 });
    return parseWorkBuddyCredits(String(result.stdout));
  } catch {
    // Desktop data is optional. A missing sqlite binary or locked DB must not
    // affect the other provider adapters.
    return null;
  }
}

async function fetchWorkBuddyBalanceCommand(command: string): Promise<PlanRow | null> {
  try {
    const result = await execFileAsync("/bin/sh", ["-c", command], { maxBuffer: 64 * 1024, timeout: 10_000 });
    return parseWorkBuddyBalance(String(result.stdout));
  } catch {
    return null;
  }
}

export function parseWorkBuddyBalance(json: string): PlanRow | null {
  let value: unknown;
  try { value = JSON.parse(json); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  const root = value as Record<string, unknown>;
  const remaining = finiteOptional(root.remaining);
  const used = finiteOptional(root.used);
  const limit = finiteOptional(root.limit);
  const unit = typeof root.unit === "string" && root.unit.trim() ? root.unit.trim() : "credits";
  if (remaining === undefined && used === undefined && limit === undefined) return null;
  return {
    form: "api",
    provider: "workbuddy",
    label: "WorkBuddy Desktop",
    level: "green",
    pacing: "",
    cardTiming: "",
    autoResetIn: typeof root.reset_at === "string" ? root.reset_at : "",
    sustainableRate: 0,
    actualVsSustainable: 0,
    projectedCapHitAt: null,
    ...(remaining !== undefined ? { remaining } : {}),
    ...(used !== undefined ? { used } : {}),
    ...(limit !== undefined ? { limit } : {}),
    unit,
  };
}

export function parseWorkBuddyCredits(json: string): PlanRow | null {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  const rows = parsed.filter((row): row is UsageRow => !!row && typeof row === "object");
  if (rows.length === 0) return null;

  const used = rows.reduce((sum, row) => sum + finiteNonNegative(row.used), 0);
  const size = rows.reduce((sum, row) => sum + finiteNonNegative(row.size), 0);
  const credits = rows.reduce((sum, row) => sum + creditTotal(row.credit_json), 0);
  const hasCredits = rows.some(row => creditTotal(row.credit_json) > 0);
  const totalUsed = hasCredits ? credits : used;
  const totalLimit = hasCredits ? undefined : size > 0 ? size : undefined;
  if (totalUsed <= 0 && totalLimit === undefined) return null;

  return {
    form: "api",
    provider: "workbuddy",
    label: "WorkBuddy Desktop",
    level: "green",
    pacing: "",
    cardTiming: "",
    autoResetIn: "",
    sustainableRate: 0,
    actualVsSustainable: 0,
    projectedCapHitAt: null,
    used: totalUsed,
    ...(totalLimit !== undefined ? { limit: totalLimit } : {}),
    unit: "credits",
  };
}

function creditTotal(value: unknown): number {
  if (!value || typeof value !== "string") return 0;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return 0;
    return Object.values(parsed as Record<string, unknown>)
      .reduce<number>((sum, item) => sum + finiteNonNegative(item), 0);
  } catch { return 0; }
}

function finiteNonNegative(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function finiteOptional(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}
