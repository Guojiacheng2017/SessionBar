import { computeAdvice } from "../quota-engine/quotaEngine.js";
import type { QuotaState } from "../quota-engine/types.js";
import type { PlanRow } from "../planTypes.js";

const USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const FETCH_TIMEOUT_MS = 10_000;
const MS_PER_HOUR = 3_600_000;
const WEEK_MS = 7 * 24 * MS_PER_HOUR;
/** duration=300 (min) = 5h 滚动窗口 */
const FIVE_HOUR_DURATION = 300;

interface KimiOpts {
  accessToken?: string;
  fetchImpl?: typeof fetch;
  now?: number;
}

export async function fetchKimiSubscription(opts: KimiOpts = {}): Promise<PlanRow[]> {
  const now = opts.now ?? Date.now();
  if (!opts.accessToken) return [];
  try {
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let body: unknown;
    try {
      const resp = await fetchImpl(USAGE_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${opts.accessToken}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      if (!resp.ok) return [];
      body = await resp.json().catch(() => null);
    } catch {
      return [];
    } finally {
      clearTimeout(t);
    }
    if (!body || typeof body !== "object") return [];

    const root = body as Record<string, unknown>;
    const rows: PlanRow[] = [];

    // overall 行用 usage.limit/remaining
    const usage = sub(root, "usage");
    if (usage) {
      const limit = num(usage.limit);
      const remaining = num(usage.remaining);
      const resetAt = parseTs(usage.resetTime);
      if (limit !== undefined && remaining !== undefined) {
        const row = buildRow("整体", "weekly", limit, remaining, resetAt, now);
        if (row) rows.push(row);
      }
    }

    // windowed 行用 limits[].detail；duration=300 → 5h 窗口
    const limits = Array.isArray(root.limits) ? root.limits : [];
    for (const w of limits) {
      if (!w || typeof w !== "object") continue;
      const entry = w as Record<string, unknown>;
      const detail = sub(entry, "detail");
      if (!detail) continue;
      const limit = num(detail.limit);
      const remaining = num(detail.remaining);
      const resetAt = parseTs(detail.resetTime);
      if (limit === undefined || remaining === undefined || resetAt === undefined) continue;
      const window = sub(entry, "window");
      const duration = num(window?.duration);
      const isFiveHour = duration === FIVE_HOUR_DURATION;
      const row = buildRow(isFiveHour ? "5h" : "窗口", isFiveHour ? "5h" : "weekly", limit, remaining, resetAt, now);
      if (row) rows.push(row);
    }
    return rows;
  } catch {
    return [];
  }
}

function buildRow(
  label: string,
  window: "5h" | "weekly",
  limit: number,
  remaining: number,
  resetAt: number | undefined,
  now: number,
): PlanRow | null {
  const state: QuotaState = {
    window,
    limit,
    remaining: Math.max(0, remaining),
    resetAt: resetAt ?? now + WEEK_MS,
    rateSamples: [],
  };
  const advice = computeAdvice(state, now);
  return {
    form: "subscription",
    provider: "kimi",
    label: `Kimi 订阅 (${label})`,
    level: advice.level,
    pacing: advice.pacing,
    cardTiming: advice.cardTiming,
    autoResetIn: advice.autoResetIn,
    sustainableRate: advice.sustainableRate,
    actualVsSustainable: advice.actualVsSustainable,
    projectedCapHitAt: advice.projectedCapHitAt,
    limit,
    remaining: Math.max(0, remaining),
  };
}

function sub(obj: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = obj[key];
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") { const n = Number(v); return Number.isFinite(n) ? n : undefined; }
  return undefined;
}

function parseTs(v: unknown): number | undefined {
  if (typeof v === "number") return v < 1_000_000_000_000 ? v * 1000 : v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n < 1_000_000_000_000 ? n * 1000 : n;
    const d = Date.parse(v);
    return Number.isFinite(d) ? d : undefined;
  }
  return undefined;
}
