import type { SessionAgentSignal, SessionPayload } from "./types.js";
import { RateBuffer } from "./rateBuffer.js";
import type { PlanRow } from "./planTypes.js";

const API_KINDS = new Set(["usage", "quota", "balance"]);

/**
 * Aggregate advisor rows for a session: one display-only "api" row per
 * usage/quota/balance agent signal. api rows never run computeAdvice — they
 * only show numbers. Subscription rows are handled globally in server.ts
 * (computePlanRows), not per session. Returns [] when there are no signals.
 */
export async function computeAdvisorRows(
  session: SessionPayload,
  _buffers: Map<string, RateBuffer>,
  _now: number,
): Promise<PlanRow[]> {
  return (session.agent_signals ?? [])
    .filter(isApiSignal)
    .map(signalToApiRow);
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
    // Fall back to the signal name (e.g. "openai.usage" vs "openai.balance")
    // so distinct api signals for the same provider without labels keep
    // distinct rows instead of collapsing to the bare provider label.
    label: signal.label ?? signal.signal ?? provider,
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
