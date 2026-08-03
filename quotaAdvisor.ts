import type { SessionAgentSignal, SessionPayload, SessionAdvisor } from "./types.js";
import { computeAdvice } from "./quota-engine/quotaEngine.js";
import type { QuotaState, ResetCard } from "./quota-engine/types.js";
import { RateBuffer } from "./rateBuffer.js";

const TARGETS = ["openai", "anthropic", "codex", "claude"];

export function computeAdvisorForSession(
  session: SessionPayload,
  buffers: Map<string, RateBuffer>,
  cards: ResetCard[],
  now: number,
): SessionAdvisor | null {
  const type = (session.session_type || "").toLowerCase();
  if (!TARGETS.some(t => type.includes(t))) return null;

  const usageSignal = (session.agent_signals ?? []).find(s => s.kind === "usage" && (s.used !== undefined || s.remaining !== undefined || s.limit !== undefined));
  if (!usageSignal) return null;

  const key = usageSignal.signal;
  const buffer = buffers.get(key) ?? new RateBuffer();
  if (usageSignal.used !== undefined) buffer.record(usageSignal.used, now);
  buffers.set(key, buffer);

  const state = buildQuotaState(usageSignal, buffer, cards, now);
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

function buildQuotaState(
  signal: SessionAgentSignal,
  buffer: RateBuffer,
  cards: ResetCard[],
  now: number,
): QuotaState | null {
  const limit = signal.limit ?? (signal.remaining !== undefined && signal.used !== undefined ? signal.remaining + signal.used : undefined);
  const remaining = signal.remaining ?? (limit !== undefined && signal.used !== undefined ? limit - signal.used : undefined);
  if (limit === undefined || remaining === undefined) return null;

  return {
    window: "weekly", // v1: 默认 weekly；后续按 provider 细化
    limit,
    remaining,
    resetAt: signal.reset_at !== undefined ? (signal.reset_at < 1_000_000_000_000 ? signal.reset_at * 1000 : signal.reset_at) : now + 7 * 24 * 3_600_000,
    rateSamples: buffer.samples(),
    cards,
  };
}
