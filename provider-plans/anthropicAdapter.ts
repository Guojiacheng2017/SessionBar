import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { computeAdvice } from "../quota-engine/quotaEngine.js";
import type { QuotaState } from "../quota-engine/types.js";
import type { PlanRow } from "../planTypes.js";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const FETCH_TIMEOUT_MS = 10_000;

interface AnthropicOpts {
  credentialsPath?: string;
  fetchImpl?: typeof fetch;
  now?: number;
}

export async function fetchAnthropicSubscription(opts: AnthropicOpts = {}): Promise<PlanRow[]> {
  const now = opts.now ?? Date.now();
  try {
    const credPath = opts.credentialsPath ?? join(homedir(), ".claude", ".credentials.json");
    if (!existsSync(credPath)) return [];
    const cred = JSON.parse(readFileSync(credPath, "utf-8"));
    // ~/.claude/.credentials.json 结构不固定：{ tokens: { accessToken } } 或 { oauth: { access_token } } 或 { accessToken }
    const token = cred?.tokens?.accessToken ?? cred?.accessToken ?? cred?.oauth?.access_token;
    if (!token) return [];

    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let body: unknown;
    try {
      const resp = await fetchImpl(USAGE_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
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

    const rows: PlanRow[] = [];
    for (const [windowName, utilField] of [
      ["5h", "five_hour"],
      ["weekly", "seven_day"],
    ] as const) {
      const w = (body as Record<string, unknown>)[utilField];
      if (!w || typeof w !== "object") continue;
      const window = w as Record<string, unknown>;
      const utilization = num(window.utilization);
      const resetAt = parseTs(window.resets_at);
      if (utilization === undefined || resetAt === undefined) continue;
      const row = buildRow(windowName, utilization, resetAt, now);
      if (row) rows.push(row);
    }
    return rows;
  } catch {
    return [];
  }
}

function buildRow(windowName: "5h" | "weekly", utilization: number, resetAt: number, now: number): PlanRow | null {
  // oauth usage 只给 utilization % + reset，无数值 limit → 用 100 作为抽象额度
  const state: QuotaState = {
    window: windowName,
    limit: 100,
    remaining: Math.max(0, 100 - utilization),
    resetAt,
    rateSamples: [],
  };
  const advice = computeAdvice(state, now);
  return {
    form: "subscription",
    provider: "anthropic",
    label: `Anthropic 订阅 (${windowName})`,
    level: advice.level,
    pacing: advice.pacing,
    cardTiming: advice.cardTiming,
    autoResetIn: advice.autoResetIn,
    sustainableRate: advice.sustainableRate,
    actualVsSustainable: advice.actualVsSustainable,
    projectedCapHitAt: advice.projectedCapHitAt,
  };
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
