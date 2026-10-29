import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PlanRow } from "./planTypes.js";
import { execProviderFile } from "./providerProcess.js";

const execSqlite = "sqlite3";

export interface WorkBuddyCreditsOpts {
  dbPath?: string;
  sqlitePath?: string;
  balanceCommand?: string;
}

interface UsageRow {
  credit_json?: unknown;
  updated_at?: unknown;
}

/** Sum recorded Desktop session credit consumption; this is not an account balance. */
export async function fetchWorkBuddyDesktopCredits(opts: WorkBuddyCreditsOpts = {}): Promise<PlanRow | null> {
  const balanceCommand = opts.balanceCommand ?? process.env.SESSIONBAR_WORKBUDDY_BALANCE_COMMAND;
  if (balanceCommand) {
    const balanceRow = await fetchWorkBuddyBalanceCommand(balanceCommand);
    if (balanceRow) return balanceRow;
  }
  const dbPath = opts.dbPath ?? join(homedir(), ".workbuddy", "workbuddy.db");
  if (!existsSync(dbPath)) return null;
  try {
    const result = await execProviderFile(opts.sqlitePath ?? execSqlite, [
      "-readonly",
      "-batch",
      "-json",
      "-cmd", ".timeout 50",
      dbPath,
      "PRAGMA query_only=ON; SELECT credit_json, updated_at FROM session_usage WHERE credit_json IS NOT NULL;",
    ], { maxBuffer: 256 * 1024, timeout: 1_000, network: false });
    return parseWorkBuddyCredits(String(result.stdout));
  } catch {
    // Desktop data is optional. A missing sqlite binary or locked DB must not
    // affect the other provider adapters.
    return null;
  }
}

async function fetchWorkBuddyBalanceCommand(command: string): Promise<PlanRow | null> {
  try {
    const result = await execProviderFile("/bin/sh", ["-c", command], { maxBuffer: 64 * 1024, timeout: 10_000 });
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
  const rows = parsed.filter((row): row is UsageRow => !!row && typeof row === "object" && !Array.isArray(row));
  if (rows.length === 0) return null;

  let totalUsed = 0;
  let hasCredits = false;
  let lastSeenAt: number | undefined;
  for (const row of rows) {
    // ACP used/size describe context occupancy, not a credit allowance.
    const credits = creditTotal(row.credit_json);
    if (credits === undefined) continue;
    hasCredits = true;
    totalUsed += credits;
    const timestamp = finiteOptional(row.updated_at);
    if (timestamp !== undefined) lastSeenAt = Math.max(lastSeenAt ?? 0, timestamp);
  }
  if (!hasCredits || !Number.isFinite(totalUsed)) return null;

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
    ...(lastSeenAt !== undefined ? { lastSeenAt } : {}),
    unit: "credits",
  };
}

function creditTotal(value: unknown): number | undefined {
  if (!value || typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const amounts = Object.values(parsed).map(finiteOptional).filter((value): value is number => value !== undefined);
    if (amounts.length === 0) return undefined;
    const total = amounts.reduce((sum, amount) => sum + amount, 0);
    return Number.isFinite(total) ? total : undefined;
  } catch { return undefined; }
}

function finiteOptional(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}
