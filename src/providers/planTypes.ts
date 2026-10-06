export type PlanForm = "subscription" | "api";

export interface ProviderUsageTrend {
  kind: "bars" | "line";
  days: 7 | 30;
  points: Array<number | null>;
  labels?: string[];
  unit?: string;
  source?: string;
}

export type ProviderUsageMode = "token" | "cash" | "percentage";

export interface ProviderUsageTrends {
  token?: ProviderUsageTrend;
  cash?: ProviderUsageTrend;
  percentage?: ProviderUsageTrend;
}

export interface PlanRow {
  form: PlanForm;
  provider: string;
  label: string;
  // subscription form (has limit -> computeAdvice fully computes)
  level: "green" | "yellow" | "red";
  pacing: string;
  measuredRate?: number;
  /** Human-readable observed rate. The numeric rate remains hourly for projections. */
  measuredRateLabel?: string;
  cardTiming: string;
  autoResetIn: string;
  sustainableRate: number;
  actualVsSustainable: number | null;
  projectedCapHitAt: number | null;
  // Live usage/balance values. API rows and subscription rows may both expose them.
  remaining?: number;
  used?: number;
  limit?: number;
  unit?: string;
  usageTrend?: ProviderUsageTrend;
  usageTrends?: ProviderUsageTrends;
  /** Last successful upstream observation. Retained rows are explicitly stale. */
  lastSeenAt?: number;
  stale?: boolean;
}
