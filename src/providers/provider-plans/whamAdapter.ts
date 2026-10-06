import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { randomUUID } from "node:crypto";
import { computeAdvice } from "../quota-engine/quotaEngine.js";
import type { QuotaState, ResetCard } from "../quota-engine/types.js";
import type { PlanRow } from "../planTypes.js";
import { num, parseTs, sub } from "./adapterUtils.js";

const WHAM_USAGE = "https://chatgpt.com/backend-api/wham/usage";
const WHAM_PROFILE = "https://chatgpt.com/backend-api/wham/profiles/me";
const WHAM_CREDITS = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const WHAM_CONSUME = `${WHAM_CREDITS}/consume`;
const MS_PER_HOUR = 3_600_000;
const WEEKLY_WINDOW_MS = 7 * 24 * MS_PER_HOUR;
const AUTO_CONSUME_WINDOW_MS = 5 * 60_000;

interface WhamOpts {
  authJsonPath?: string;
  fetchImpl?: typeof fetch;
  now?: number;
  autoConsumeResetCards?: boolean;
  autoConsumeBeforeMs?: number;
  consumptionStatePath?: string;
  onResetCardConsume?: (result: ResetCardConsumeResult) => void | Promise<void>;
}

export type ResetCardConsumeOutcome = "reset" | "alreadyRedeemed" | "nothingToReset" | "noCredit" | "error";

export interface ResetCardConsumeResult {
  outcome: ResetCardConsumeOutcome;
  cardId?: string;
  idempotencyKey?: string;
  reason?: string;
}

interface WhamAuth {
  headers: Record<string, string>;
}

const memoryRedeemKeys = new Map<string, string>();

export async function fetchOpenAISubscription(opts: WhamOpts = {}): Promise<PlanRow | null> {
  const now = opts.now ?? Date.now();
  try {
    const authPath = opts.authJsonPath ?? join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
    if (!existsSync(authPath)) return null;
    const auth = readWhamAuth(authPath);
    if (!auth) return null;
    const headers = auth.headers;
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

    let [usageBody, creditsBody, profileBody] = await Promise.all([
      fetchJson(fetchImpl, WHAM_USAGE, headers),
      fetchJson(fetchImpl, WHAM_CREDITS, headers),
      fetchJson(fetchImpl, WHAM_PROFILE, headers),
    ]);
    let cards = parseCredits(creditsBody, now);

    if (opts.autoConsumeResetCards) {
      const candidate = nearestExpiringCard(cards, now);
      const windowMs = Number.isFinite(opts.autoConsumeBeforeMs)
        ? Math.max(0, opts.autoConsumeBeforeMs!)
        : AUTO_CONSUME_WINDOW_MS;
      if (candidate?.id && candidate.expiresAt !== undefined && candidate.expiresAt - now <= windowMs) {
        const result = await consumeResetCard({
          authJsonPath: authPath,
          cardId: candidate.id,
          consumptionStatePath: opts.consumptionStatePath,
          fetchImpl,
        });
        if (result.outcome === "reset" || result.outcome === "alreadyRedeemed") {
          try { await opts.onResetCardConsume?.(result); } catch { /* status callback must not hide provider data */ }
          // The provider's usage window and card list are authoritative after a
          // redemption; do not infer the new state from the POST response.
          [usageBody, creditsBody] = await Promise.all([
            fetchJson(fetchImpl, WHAM_USAGE, headers),
            fetchJson(fetchImpl, WHAM_CREDITS, headers),
          ]);
          cards = parseCredits(creditsBody, now);
        }
      }
    }

    const usage: Record<string, unknown> = usageBody && typeof usageBody === "object"
      ? usageBody as Record<string, unknown>
      : {};

    // wham/usage real shape: weekly quota lives in rate_limit.primary_window (used_percent / reset_at).
    // codex /status "54% left (resets Aug 8)" derives from used_percent=46 + reset_at.
    const rateLimit = sub(usage, "rate_limit");
    const primary = sub(rateLimit, "primary_window");
    const utilization = num(primary?.used_percent ?? usage.utilization);
    const resetRaw = primary?.reset_at ?? usage.reset_at;
    const resetAt = resetRaw ? parseTs(resetRaw) : undefined;
    if (utilization === undefined) return null; // no weekly quota data -> skip

    // wham/usage only provides used_percent + reset, no numeric quota -> use 100 as an abstract percent quota
    const limit = 100;
    const remaining = Math.max(0, Math.round(limit * (1 - utilization / 100)));
    const dailyRate = weeklyAverageDailyRate(utilization, resetAt, now);
    const state: QuotaState = {
      window: "weekly",
      limit,
      remaining,
      resetAt: resetAt ?? now + 7 * 24 * MS_PER_HOUR,
      // QuotaEngine projects in hours. This is a calendar-day baseline, not an
      // hourly EMA, so convert it to an hourly equivalent for projection only.
      rateSamples: dailyRate === undefined ? [] : [
        { value: dailyRate / 24, at: now - 1 },
        { value: dailyRate / 24, at: now },
      ],
      rateUnit: "%",
      cards,
    };
    const advice = computeAdvice(state, now);
    const usageTrend = parseDailyTokenUsage(profileBody, now);
    return {
      form: "subscription",
      provider: "openai",
      label: "OpenAI Subscription",
      level: advice.level,
      pacing: advice.pacing,
      measuredRate: advice.measuredRate,
      ...(dailyRate === undefined ? {} : { measuredRateLabel: `${formatRate(dailyRate)}%/day avg` }),
      cardTiming: advice.cardTiming,
      autoResetIn: advice.autoResetIn,
      sustainableRate: advice.sustainableRate,
      actualVsSustainable: advice.actualVsSustainable,
      projectedCapHitAt: advice.projectedCapHitAt,
      // percent quota (wham only gives used_percent, no numeric tokens): remaining = remaining percent
      remaining,
      limit,
      unit: "%",
      ...(usageTrend ? { usageTrend } : {}),
    };
  } catch {
    return null;
  }
}

function weeklyAverageDailyRate(
  utilization: number,
  resetAt: number | undefined,
  now: number,
): number | undefined {
  if (resetAt === undefined) return undefined;
  const windowStartedAt = resetAt - WEEKLY_WINDOW_MS;
  const elapsedDays = (now - windowStartedAt) / (24 * MS_PER_HOUR);
  if (!Number.isFinite(elapsedDays) || elapsedDays <= 0) return undefined;
  return Math.max(0, utilization) / elapsedDays;
}

function formatRate(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2, useGrouping: false });
}

function parseDailyTokenUsage(body: unknown, now: number): PlanRow["usageTrend"] | undefined {
  if (!body || typeof body !== "object") return undefined;
  const root = body as Record<string, unknown>;
  const stats = root.stats && typeof root.stats === "object" ? root.stats as Record<string, unknown> : undefined;
  const buckets = stats?.daily_usage_buckets ?? root.daily_usage_buckets;
  if (!Array.isArray(buckets)) return undefined;
  const totals = new Map<string, number>();
  for (const bucket of buckets) {
    if (!bucket || typeof bucket !== "object") continue;
    const record = bucket as Record<string, unknown>;
    const day = typeof record.start_date === "string" ? record.start_date : undefined;
    const tokens = Number(record.tokens);
    if (day && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(tokens) && tokens >= 0) totals.set(day, tokens);
  }
  if (totals.size === 0) return undefined;
  const cursor = new Date(now);
  cursor.setHours(12, 0, 0, 0);
  const labels = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(cursor);
    date.setDate(cursor.getDate() - (6 - index));
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  });
  return {
    kind: "bars",
    days: 7,
    points: labels.map(day => totals.get(day) ?? null),
    labels,
    unit: "tokens",
    source: "OpenAI API",
  };
}

export async function consumeResetCard(opts: {
  authJsonPath?: string;
  cardId?: string;
  idempotencyKey?: string;
  consumptionStatePath?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<ResetCardConsumeResult> {
  try {
    const authPath = opts.authJsonPath ?? join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
    const auth = readWhamAuth(authPath);
    if (!auth) return { outcome: "error", reason: "missing auth" };

    const scope = `${authPath}\u0000${opts.cardId || "next"}`;
    const idempotencyKey = opts.idempotencyKey || loadRedeemKey(opts.consumptionStatePath, scope);
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    const body: Record<string, string> = { redeem_request_id: idempotencyKey };
    if (opts.cardId) body.credit_id = opts.cardId;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetchImpl(WHAM_CONSUME, {
        method: "POST",
        headers: { ...auth.headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);
      const parsed = consumeOutcome(payload);
      const outcome = parsed || (response.ok ? "reset" : "error");
      return {
        outcome,
        cardId: opts.cardId,
        idempotencyKey,
        ...(outcome === "error" ? { reason: `HTTP ${response.status}` } : {}),
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return { outcome: "error", reason: error instanceof Error ? error.message : "request failed" };
  }
}

function parseCredits(body: unknown, now: number): ResetCard[] {
  const obj: Record<string, unknown> = body && typeof body === "object"
    ? body as Record<string, unknown>
    : {};
  const arr = Array.isArray(body) ? body : Array.isArray(obj.credits) ? obj.credits : [];
  const retained = arr
    .filter((c: any) => c && typeof c === "object" && (c.status === undefined || c.status === "available"))
    .map((c: any) => ({
      id: typeof c.id === "string" && c.id.trim()
        ? c.id.trim()
        : typeof c.credit_id === "string" && c.credit_id.trim()
          ? c.credit_id.trim()
          : undefined,
      expiresAt: parseTs(c.expires_at),
    }))
    .filter((c: any) => c.expiresAt !== undefined && c.expiresAt > now - 30 * 24 * MS_PER_HOUR);
  return retained.map(c => ({
    count: 1,
    ...(c.id ? { id: c.id } : {}),
    expiresAt: c.expiresAt,
  }));
}

function nearestExpiringCard(cards: ResetCard[], now: number): ResetCard | undefined {
  return cards
    .filter((card): card is ResetCard & { expiresAt: number } =>
      card.expiresAt !== undefined && card.expiresAt > now && card.count > 0,
    )
    .sort((a, b) => a.expiresAt - b.expiresAt)[0];
}

function readWhamAuth(authPath: string): WhamAuth | null {
  try {
    const auth = JSON.parse(readFileSync(authPath, "utf-8"));
    const token = auth?.tokens?.access_token;
    // Codex has used both top-level account_id and tokens.account_id.
    // The latter is the current auth.json shape and is required by Wham.
    const accountId = auth?.account_id ?? auth?.tokens?.account_id;
    if (typeof token !== "string" || !token) return null;
    return {
      headers: {
        Authorization: `Bearer ${token}`,
        ...(accountId ? { "ChatGPT-Account-Id": String(accountId) } : {}),
      },
    };
  } catch {
    return null;
  }
}

function consumeOutcome(payload: unknown): Exclude<ResetCardConsumeOutcome, "error"> | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const raw = (payload as Record<string, unknown>).outcome ?? (payload as Record<string, unknown>).status;
  if (typeof raw !== "string") return undefined;
  switch (raw.toLowerCase().replace(/[\s_-]/g, "")) {
    case "reset": return "reset";
    case "alreadyredeemed": return "alreadyRedeemed";
    case "nothingtoreset": return "nothingToReset";
    case "nocredit": return "noCredit";
    default: return undefined;
  }
}

function loadRedeemKey(statePath: string | undefined, scope: string): string {
  if (memoryRedeemKeys.has(scope)) return memoryRedeemKeys.get(scope)!;
  if (statePath) {
    try {
      const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
      const saved = state[scope];
      if (typeof saved === "string" && saved) {
        memoryRedeemKeys.set(scope, saved);
        return saved;
      }
    } catch { /* first attempt or malformed state */ }
  }

  const generated = randomUUID();
  memoryRedeemKeys.set(scope, generated);
  if (statePath) {
    try {
      let state: Record<string, unknown> = {};
      try { state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>; } catch { /* new state */ }
      state[scope] = generated;
      mkdirSync(dirname(statePath), { recursive: true });
      const tempPath = `${statePath}.tmp-${process.pid}`;
      writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      renameSync(tempPath, statePath);
    } catch { /* the in-memory key still makes this process idempotent */ }
  }
  return generated;
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
