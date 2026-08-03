import type { Advice, QuotaState, ResetCard } from "./types.js";
import { estimateRate } from "./rateEstimator.js";

const MS_PER_HOUR = 3_600_000;
const CARD_EXPIRY_GRACE_MS = 24 * 3_600_000;

export function computeAdvice(state: QuotaState, now: number): Advice {
  const { remaining, limit, resetAt } = state;
  const measuredRate = estimateRate(
    state.rateSamples,
    state.rateMethod,
    state.maWindow,
  );

  const windowReset = resetAt <= now;
  const hoursUntilReset = (resetAt - now) / MS_PER_HOUR;
  let sustainableRate = 0;
  if (hoursUntilReset > 0) sustainableRate = remaining / hoursUntilReset;

  let projectedCapHitAt: number | null = null;
  if (measuredRate > 0 && remaining > 0) {
    const hoursToZero = remaining / measuredRate;
    projectedCapHitAt = now + hoursToZero * MS_PER_HOUR;
    if (projectedCapHitAt > resetAt) projectedCapHitAt = null;
  }

  const actualVsSustainable = sustainableRate > 0
    ? measuredRate / sustainableRate
    : measuredRate > 0 ? null : 0;

  let level: Advice["level"] = "green";
  if (remaining === 0) {
    level = "red";
  } else if (remaining < limit * 0.05 && measuredRate > 0) {
    level = "red";
  } else if (projectedCapHitAt !== null) {
    const windowMs = resetAt - now;
    level = projectedCapHitAt - now < windowMs / 2 ? "red" : "yellow";
  } else if (measuredRate > sustainableRate && sustainableRate > 0) {
    level = "yellow";
  }

  let pacing = pacingText(remaining, measuredRate, sustainableRate, level);
  if (windowReset) {
    // expired window: never report a normal green/OK pacing with sustainable 0
    level = "yellow";
    pacing = "窗口已重置，重新评估额度";
  }

  const cardTiming = cardTimingText(state.cards ?? [], projectedCapHitAt, resetAt, now, remaining);
  const autoResetIn = autoResetText(resetAt, now);

  return { sustainableRate, actualVsSustainable, projectedCapHitAt, level, pacing, cardTiming, autoResetIn };
}

function pacingText(remaining: number, measuredRate: number, sustainableRate: number, level: string): string {
  if (remaining === 0) return "额度已耗尽，等待重置或使用重置卡";
  if (measuredRate <= 0) return "数据不足，先观察消耗速率";
  const rate = Math.round(sustainableRate);
  if (level === "red") {
    if (measuredRate > sustainableRate) return `烧太快：按 ≤ ${rate} token/小时 消耗才能撑到重置`;
    return "额度不足：剩余 <5%，建议暂停或使用重置卡";
  }
  if (level === "yellow") return `建议减速：目标 ≤ ${rate} token/小时`;
  return `可持续消耗速率 ${rate} token/小时，当前节奏 OK`;
}

function cardTimingText(
  cards: ResetCard[],
  projectedCapHitAt: number | null,
  resetAt: number,
  now: number,
  remaining: number,
): string {
  // expired cards are not actionable — exclude them entirely
  const active = cards.filter(
    c => c.count > 0 && (c.expiresAt === undefined || c.expiresAt - now >= 0),
  );
  const total = active.reduce((sum, c) => sum + c.count, 0);
  if (total === 0) return "无重置卡可建议";
  const expiringSoon = active.some(
    c => c.expiresAt !== undefined && c.expiresAt - now < CARD_EXPIRY_GRACE_MS,
  );
  if (expiringSoon) return "有卡即将过期（<24h），立即用卡，避免作废";
  // remaining 0 counts as cap-hit even though projectedCapHitAt is null for it
  const capped = remaining === 0 || (projectedCapHitAt !== null && projectedCapHitAt < resetAt);
  if (capped) return "现在用卡最佳：额度已耗尽或触顶在即，且自然重置还远";
  const expiresBeforeReset = active.find(
    c => c.expiresAt !== undefined && c.expiresAt < resetAt,
  );
  if (expiresBeforeReset) {
    return `未触顶，但卡将于 ${formatDuration(expiresBeforeReset.expiresAt! - now)} 后过期（先于重置），注意别浪费`;
  }
  return "未触顶，攒卡（有效期 30 天），重置后再评估";
}

function formatDuration(ms: number): string {
  const days = Math.floor(ms / (24 * MS_PER_HOUR));
  const hours = Math.floor((ms % (24 * MS_PER_HOUR)) / MS_PER_HOUR);
  if (days > 0) return hours > 0 ? `${days}天${hours}小时` : `${days}天`;
  const hoursTotal = Math.floor(ms / MS_PER_HOUR);
  if (hoursTotal > 0) return `${hoursTotal}小时`;
  return `${Math.max(1, Math.ceil(ms / 60_000))}分钟`;
}

function autoResetText(resetAt: number, now: number): string {
  if (resetAt <= now) return "重置中/即将重置";
  const diffMs = resetAt - now;
  if (diffMs < 24 * MS_PER_HOUR) {
    const resetDate = new Date(resetAt);
    const nowDate = new Date(now);
    const sameDay =
      resetDate.getFullYear() === nowDate.getFullYear() &&
      resetDate.getMonth() === nowDate.getMonth() &&
      resetDate.getDate() === nowDate.getDate();
    if (sameDay) {
      const hh = resetDate.getHours().toString().padStart(2, "0");
      const mm = resetDate.getMinutes().toString().padStart(2, "0");
      return `at ${hh}:${mm}`;
    }
    if (diffMs < MS_PER_HOUR) {
      const min = Math.max(1, Math.ceil(diffMs / 60_000));
      return `unblocked in ${min}m`;
    }
    const h = Math.floor(diffMs / MS_PER_HOUR);
    const m = Math.floor((diffMs % MS_PER_HOUR) / 60_000);
    return `unblocked in ${h}h${m.toString().padStart(2, "0")}m`;
  }
  const d = Math.floor(diffMs / (24 * MS_PER_HOUR));
  const h = Math.floor((diffMs % (24 * MS_PER_HOUR)) / MS_PER_HOUR);
  return `unblocked in ${d}d ${h}h`;
}
