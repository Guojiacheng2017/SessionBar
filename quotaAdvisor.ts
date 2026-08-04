import type { SessionAgentSignal, SessionPayload } from "./types.js";
import { RateBuffer } from "./rateBuffer.js";
import { computePlanRows } from "./planAdvisor.js";
import type { PlanRow } from "./planTypes.js";

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
