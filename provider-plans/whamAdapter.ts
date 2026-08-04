import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { computeAdvice } from "../quota-engine/quotaEngine.js";
import type { QuotaState, ResetCard } from "../quota-engine/types.js";
import type { PlanRow } from "../planTypes.js";

const WHAM_USAGE = "https://chatgpt.com/backend-api/wham/usage";
const WHAM_CREDITS = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const MS_PER_HOUR = 3_600_000;

interface WhamOpts {
  authJsonPath?: string;
  fetchImpl?: typeof fetch;
  now?: number;
}

export async function fetchOpenAISubscription(opts: WhamOpts = {}): Promise<PlanRow | null> {
  const now = opts.now ?? Date.now();
  try {
    const authPath = opts.authJsonPath ?? join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
    if (!existsSync(authPath)) return null;
    const auth = JSON.parse(readFileSync(authPath, "utf-8"));
    const token = auth?.tokens?.access_token;
    const accountId = auth?.account_id;
    if (!token) return null;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (accountId) headers["ChatGPT-Account-Id"] = String(accountId);
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

    const [usageBody, creditsBody] = await Promise.all([
      fetchJson(fetchImpl, WHAM_USAGE, headers),
      fetchJson(fetchImpl, WHAM_CREDITS, headers),
    ]);
    const cards = parseCredits(creditsBody, now);
    const usage: Record<string, unknown> = usageBody && typeof usageBody === "object"
      ? usageBody as Record<string, unknown>
      : {};

    // wham/usage 真实形状把周限额指标嵌套在 usage.usage 下；rate_limit_reset_credits.available_count 只在顶层。
    // 防御性读取：先取嵌套 usage.usage，再回退到顶层 / rate_limit_reset_credits。
    const nested = sub(usage, "usage");
    const rlrc = sub(usage, "rate_limit_reset_credits");
    const utilization = num(nested?.utilization ?? usage.utilization ?? rlrc?.used_percent);
    const limit = num(nested?.limit ?? usage.limit ?? rlrc?.limit);
    const resetRaw = nested?.reset_at ?? usage.reset_at ?? rlrc?.reset_at;
    const resetAt = resetRaw ? parseTs(resetRaw) : undefined;
    if (limit === undefined || utilization === undefined) return null; // 无周限额数据 → 跳过

    const remaining = Math.max(0, Math.round(limit * (1 - utilization / 100)));
    const state: QuotaState = {
      window: "weekly",
      limit,
      remaining,
      resetAt: resetAt ?? now + 7 * 24 * MS_PER_HOUR,
      rateSamples: [],
      cards,
    };
    const advice = computeAdvice(state, now);
    return {
      form: "subscription",
      provider: "openai",
      label: "OpenAI ChatGPT 订阅",
      level: advice.level,
      pacing: advice.pacing,
      cardTiming: advice.cardTiming,
      autoResetIn: advice.autoResetIn,
      sustainableRate: advice.sustainableRate,
      actualVsSustainable: advice.actualVsSustainable,
      projectedCapHitAt: advice.projectedCapHitAt,
    };
  } catch {
    return null;
  }
}

function sub(obj: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = obj[key];
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

function parseCredits(body: unknown, now: number): ResetCard[] {
  const obj: Record<string, unknown> = body && typeof body === "object"
    ? body as Record<string, unknown>
    : {};
  const arr = Array.isArray(body) ? body : Array.isArray(obj.credits) ? obj.credits : [];
  const active = arr
    .filter((c: any) => c && typeof c === "object" && (c.status === undefined || c.status === "available"))
    .map((c: any) => ({ expiresAt: parseTs(c.expires_at) }))
    .filter((c: any) => c.expiresAt !== undefined && c.expiresAt > now);
  return active.map(c => ({ count: 1, expiresAt: c.expiresAt }));
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

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") { const n = Number(v); return Number.isFinite(n) ? n : undefined; }
  return undefined;
}

async function fetchJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string>): Promise<unknown> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await fetchImpl(url, { method: "GET", headers, signal: controller.signal });
    if (!resp.ok) return null;
    return resp.json().catch(() => null);
  } catch { return null; }
  finally { clearTimeout(t); }
}
