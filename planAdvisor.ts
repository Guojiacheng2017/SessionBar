import { fetchOpenAISubscription } from "./provider-plans/whamAdapter.js";
import { fetchAnthropicSubscription } from "./provider-plans/anthropicAdapter.js";
import { fetchKimiSubscription } from "./provider-plans/kimiAdapter.js";
import type { PlanRow } from "./planTypes.js";

export interface PlanOpts {
  now?: number;
  openaiAuthPath?: string;
  anthropicCredentialsPath?: string;
  kimiAccessToken?: string;
}

/**
 * Aggregate every available subscription adapter into a single PlanRow[].
 * Each adapter is awaited independently: a rejection (or missing credentials)
 * in one provider must never break the others.
 */
export async function computePlanRows(opts: PlanOpts = {}): Promise<PlanRow[]> {
  const now = opts.now ?? Date.now();
  const results = await Promise.allSettled([
    fetchOpenAISubscription({ authJsonPath: opts.openaiAuthPath, now }),
    fetchAnthropicSubscription({ credentialsPath: opts.anthropicCredentialsPath, now }),
    fetchKimiSubscription({ accessToken: opts.kimiAccessToken, now }),
  ]);
  const rows: PlanRow[] = [];
  for (const r of results) {
    if (r.status === "rejected") continue;
    const value = r.value;
    if (Array.isArray(value)) rows.push(...value);
    else if (value) rows.push(value);
  }
  return rows;
}
