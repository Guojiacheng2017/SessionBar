export type PlanForm = "subscription" | "api";

export interface PlanRow {
  form: PlanForm;
  provider: string;
  label: string;
  // subscription form (has limit -> computeAdvice fully computes)
  level: "green" | "yellow" | "red";
  pacing: string;
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
}
