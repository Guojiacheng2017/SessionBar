import { fetchOpenAISubscription } from "./provider-plans/whamAdapter.js";
import type { ResetCardConsumeResult } from "./provider-plans/whamAdapter.js";
import { fetchAnthropicSubscription } from "./provider-plans/anthropicAdapter.js";
import { fetchKimiSubscription } from "./provider-plans/kimiAdapter.js";
import { fetchGitHubCopilotSubscription } from "./provider-plans/githubCopilotAdapter.js";
import { fetchWorkBuddyDesktopCredits } from "./workbuddyCreditsAdapter.js";
import type { PlanRow } from "./planTypes.js";
import { fetchGrokSubscription } from "./provider-plans/grokBillingAdapter.js";

export interface PlanOpts {
  now?: number;
  fetchImpl?: typeof fetch;
  grokBillingEnabled?: boolean;
  openaiAuthPath?: string;
  autoConsumeResetCards?: boolean;
  consumptionStatePath?: string;
  onResetCardConsume?: (result: ResetCardConsumeResult) => void | Promise<void>;
  anthropicCredentialsPath?: string;
  kimiAccessToken?: string;
  githubCopilotCredentialsPath?: string;
  githubCopilotToken?: string;
  workbuddyDbPath?: string;
  workbuddyBalanceCommand?: string;
}

/**
 * Aggregate every available subscription adapter into a single PlanRow[].
 * Each adapter is awaited independently: a rejection (or missing credentials)
 * in one provider must never break the others.
 */
export async function computePlanRows(opts: PlanOpts = {}): Promise<PlanRow[]> {
  const now = opts.now ?? Date.now();
  // Kimi access token falls back to env so subscription rows show whenever a
  // token is present (SESSIONBAR_ prefix wins over the bare form). Neither set
  // → kimi rows stay hidden (no-credential-hides behavior).
  const kimiAccessToken = opts.kimiAccessToken
    ?? process.env.SESSIONBAR_KIMI_ACCESS_TOKEN
    ?? process.env.KIMI_ACCESS_TOKEN;
  const results = await Promise.allSettled([
    opts.grokBillingEnabled === false ? null : fetchGrokSubscription(),
    fetchOpenAISubscription({
      authJsonPath: opts.openaiAuthPath,
      fetchImpl: opts.fetchImpl,
      autoConsumeResetCards: opts.autoConsumeResetCards,
      consumptionStatePath: opts.consumptionStatePath,
      onResetCardConsume: opts.onResetCardConsume,
      now,
    }),
    fetchAnthropicSubscription({ credentialsPath: opts.anthropicCredentialsPath, fetchImpl: opts.fetchImpl, now }),
    fetchKimiSubscription({ accessToken: kimiAccessToken, fetchImpl: opts.fetchImpl, now }),
    fetchGitHubCopilotSubscription({
      credentialsPath: opts.githubCopilotCredentialsPath,
      accessToken: opts.githubCopilotToken,
      fetchImpl: opts.fetchImpl,
      now,
    }),
    fetchWorkBuddyDesktopCredits({
      dbPath: opts.workbuddyDbPath,
      balanceCommand: opts.workbuddyBalanceCommand ?? process.env.SESSIONBAR_WORKBUDDY_BALANCE_COMMAND,
    }),
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
