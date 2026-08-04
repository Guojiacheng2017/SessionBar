export type PlanForm = "subscription" | "api";

export interface PlanRow {
  form: PlanForm;
  provider: string;
  label: string;
  // subscription 形态（有 limit → computeAdvice 全算）
  level: "green" | "yellow" | "red";
  pacing: string;
  cardTiming: string;
  autoResetIn: string;
  sustainableRate: number;
  actualVsSustainable: number | null;
  projectedCapHitAt: number | null;
  // api 形态（余额式，只显示）
  remaining?: number;
  used?: number;
  limit?: number;
  unit?: string;
}
