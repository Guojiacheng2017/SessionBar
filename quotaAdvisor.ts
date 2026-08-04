import type { SessionAgentSignal, SessionPayload, SessionAdvisor } from "./types.js";
import { computeAdvice } from "./quota-engine/quotaEngine.js";
import type { QuotaState, ResetCard, Window } from "./quota-engine/types.js";
import { RateBuffer } from "./rateBuffer.js";
import { computePlanRows } from "./planAdvisor.js";
import type { PlanRow } from "./planTypes.js";

const TARGETS = ["openai", "anthropic", "codex", "claude"];
const MS_HOUR = 3_600_000;
const MS_DAY = 24 * MS_HOUR;
const API_KINDS = new Set(["usage", "quota", "balance"]);

/**
 * Aggregate advisor rows for a session:
 *   - one display-only "api" row per usage/quota/balance agent signal, and
 *   - subscription rows from computePlanRows (wham/anthropic/kimi).
 * api rows never run computeAdvice — they only show numbers. Returns [] when
 * there is nothing to display (no signals and no subscription rows).
 */
export async function computeAdvisorRows(
  session: SessionPayload,
  _buffers: Map<string, RateBuffer>,
  now: number,
): Promise<PlanRow[]> {
  const apiRows = (session.agent_signals ?? [])
    .filter(isApiSignal)
    .map(signalToApiRow);
  const subscriptionRows = await computePlanRows({ now });
  return [...apiRows, ...subscriptionRows];
}

function isApiSignal(signal: SessionAgentSignal): boolean {
  if (!API_KINDS.has(signal.kind ?? "")) return false;
  return signal.used !== undefined
    || signal.remaining !== undefined
    || signal.limit !== undefined
    || signal.balance !== undefined;
}

function signalToApiRow(signal: SessionAgentSignal): PlanRow {
  const provider = (signal.signal || "").split(".")[0] || signal.source || "unknown";
  const remaining = signal.remaining
    ?? signal.balance
    ?? (signal.limit !== undefined && signal.used !== undefined ? signal.limit - signal.used : undefined);
  const unit = signal.unit ?? signal.balance_unit;
  return {
    form: "api",
    provider,
    label: signal.label ?? provider,
    // api form is display-only; these subscription fields are N/A.
    level: "green",
    pacing: "",
    cardTiming: "",
    autoResetIn: "",
    sustainableRate: 0,
    actualVsSustainable: null,
    projectedCapHitAt: null,
    ...(remaining !== undefined ? { remaining } : {}),
    ...(signal.used !== undefined ? { used: signal.used } : {}),
    ...(signal.limit !== undefined ? { limit: signal.limit } : {}),
    ...(unit !== undefined ? { unit } : {}),
  };
}

/**
 * @deprecated Per-session advice has been superseded by computeAdvisorRows
 * (multi-form PlanRow[]). Kept only because server.ts still consumes it;
 * Task 8 migrates server.ts and removes this path.
 */
export function computeAdvisorForSession(
  session: SessionPayload,
  buffers: Map<string, RateBuffer>,
  cards: ResetCard[],
  now: number,
): SessionAdvisor | null {
  const type = (session.session_type || "").toLowerCase();
  if (!TARGETS.some(t => type.includes(t))) return null;

  const usageSignal = (session.agent_signals ?? []).find(s =>
    (s.kind === "usage" || s.kind === "quota")
    && (s.used !== undefined || s.remaining !== undefined || s.limit !== undefined));
  if (!usageSignal) return null;

  const key = signalKey(usageSignal);
  const buffer = buffers.get(key) ?? new RateBuffer();
  if (usageSignal.used !== undefined) buffer.record(usageSignal.used, now);
  buffers.set(key, buffer);

  // wham reset cards belong to Codex/OpenAI accounts only; never attach them
  // to Anthropic/Claude sessions (they have no Codex credit pool).
  const whamCards = type.includes("openai") || type.includes("codex") ? cards : [];

  const state = buildQuotaState(session, usageSignal, buffer, whamCards, now);
  if (!state) return null;

  const advice = computeAdvice(state, now);
  return {
    level: advice.level,
    pacing: advice.pacing,
    cardTiming: advice.cardTiming,
    autoResetIn: advice.autoResetIn,
    sustainableRate: advice.sustainableRate,
    actualVsSustainable: advice.actualVsSustainable,
    projectedCapHitAt: advice.projectedCapHitAt,
  };
}

export function inferWindowForSession(session: SessionPayload): Window {
  const type = (session.session_type || "").toLowerCase();
  return type.includes("anthropic") || type.includes("claude") ? "5h" : "weekly";
}

export function defaultResetAtForWindow(window: Window, now: number): number {
  return window === "5h" ? now + 5 * MS_HOUR : now + 7 * MS_DAY;
}

function buildQuotaState(
  session: SessionPayload,
  signal: SessionAgentSignal,
  buffer: RateBuffer,
  cards: ResetCard[],
  now: number,
): QuotaState | null {
  let limit = signal.limit;
  if (limit === undefined && signal.remaining !== undefined && signal.used !== undefined) {
    limit = signal.remaining + signal.used;
  }
  if (limit === undefined && signal.used !== undefined) {
    const quotaPercent = session.quota_percent;
    if (quotaPercent !== undefined && quotaPercent >= 0 && quotaPercent < 100) {
      limit = signal.used / (1 - quotaPercent / 100);
    }
  }
  const remaining = signal.remaining ?? (limit !== undefined && signal.used !== undefined ? limit - signal.used : undefined);
  if (limit === undefined || remaining === undefined) return null;

  const window = inferWindowForSession(session);
  return {
    window,
    limit,
    remaining,
    resetAt: signal.reset_at !== undefined
      ? (signal.reset_at < 1_000_000_000_000 ? signal.reset_at * 1000 : signal.reset_at)
      : defaultResetAtForWindow(window, now),
    rateSamples: buffer.samples(),
    cards,
  };
}

function signalKey(signal: SessionAgentSignal): string {
  return `${signal.source ?? ""}:${signal.scope ?? ""}:${signal.kind ?? ""}:${signal.signal}`;
}
