import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { computeAdvice } from "../quota-engine/quotaEngine.js";
import type { QuotaState } from "../quota-engine/types.js";
import type { PlanRow } from "../planTypes.js";
import { num, parseTs } from "./adapterUtils.js";

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
    const token = extractAccessToken(cred);
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
  // oauth usage only provides utilization % + reset, no numeric limit -> use 100 as an abstract quota
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
    label: `Anthropic Subscription (${windowName})`,
    level: advice.level,
    pacing: advice.pacing,
    cardTiming: advice.cardTiming,
    autoResetIn: advice.autoResetIn,
    sustainableRate: advice.sustainableRate,
    actualVsSustainable: advice.actualVsSustainable,
    projectedCapHitAt: advice.projectedCapHitAt,
  };
}

/**
 * ~/.claude/.credentials.json structure is not fixed:
 *   { tokens: [{ accessToken, refreshToken, ... }] }  (real Claude Code shape: array)
 *   { tokens: { accessToken } }
 *   { oauth: { access_token } }
 *   { accessToken }
 * Return the first accessToken found in that order.
 */
function extractAccessToken(cred: any): string | undefined {
  if (!cred || typeof cred !== "object") return undefined;
  const tokens = cred.tokens;
  if (Array.isArray(tokens)) {
    if (typeof tokens[0]?.accessToken === "string") return tokens[0].accessToken;
  } else if (typeof tokens?.accessToken === "string") {
    return tokens.accessToken;
  }
  if (typeof cred.oauth?.access_token === "string") return cred.oauth.access_token;
  if (typeof cred.accessToken === "string") return cred.accessToken;
  return undefined;
}
