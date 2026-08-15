export type Window = "5h" | "weekly" | "monthly";

export interface ResetCard {
  count: number;
  /** provider-issued opaque credit identifier, when available */
  id?: string;
  /** epoch ms */
  expiresAt?: number;
}

export type RateMethod = "sma" | "ema" | "median" | "linear";

export interface RateSample {
  /** tokens per hour */
  value: number;
  /** epoch ms */
  at: number;
}

export interface QuotaState {
  window: Window;
  /** tokens, current window */
  limit: number;
  /** tokens left */
  remaining: number;
  /** epoch ms, natural auto-reset */
  resetAt: number;
  /** historical measured rate samples */
  rateSamples: RateSample[];
  /** default "sma" */
  rateMethod?: RateMethod;
  /** SMA/EMA window, default 5 */
  maWindow?: number;
  /** reset cards held */
  cards?: ResetCard[];
}

export type Level = "green" | "yellow" | "red";

export interface Advice {
  /** remaining / hours-until-reset */
  sustainableRate: number;
  /** measured/sustainable ratio; >1 = burning too fast; null when unsustainable (sustainable=0, burning) */
  actualVsSustainable: number | null;
  /** projected cap-hit time; null when reset arrives first */
  projectedCapHitAt: number | null;
  level: Level;
  /** sustainable-rate pacing advice string */
  pacing: string;
  /** reset-card timing advice string */
  cardTiming: string;
  /** auto-reset countdown string */
  autoResetIn: string;
}
