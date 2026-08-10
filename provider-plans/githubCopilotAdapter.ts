import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { computeAdvice } from "../quota-engine/quotaEngine.js";
import type { QuotaState } from "../quota-engine/types.js";
import type { PlanRow } from "../planTypes.js";
import { num, parseTs } from "./adapterUtils.js";

const USER_URL = "https://api.github.com/copilot_internal/user";
const FETCH_TIMEOUT_MS = 10_000;

export interface GitHubCopilotOpts {
  credentialsPath?: string;
  accessToken?: string;
  fetchImpl?: typeof fetch;
  now?: number;
  endpoint?: string;
}

/** Read the personal Copilot entitlement used by the local Copilot clients. */
export async function fetchGitHubCopilotSubscription(opts: GitHubCopilotOpts = {}): Promise<PlanRow[]> {
  const token = opts.accessToken ?? readOAuthToken(opts.credentialsPath);
  if (!token) return [];

  try {
    const body = await fetchJson(opts.fetchImpl ?? globalThis.fetch, opts.endpoint ?? USER_URL, token);
    const row = parseGitHubCopilotUser(body, opts.now ?? Date.now());
    return row ? [row] : [];
  } catch {
    return [];
  }
}

export function parseGitHubCopilotUser(body: unknown, now: number = Date.now()): PlanRow | null {
  if (!body || typeof body !== "object") return null;
  const root = body as Record<string, unknown>;
  const snapshot = selectCreditSnapshot(root.quota_snapshots);
  if (!snapshot) return null;

  const limit = num(snapshot.entitlement);
  if (limit === undefined || limit <= 0 || snapshot.unlimited === true) return null;
  const remainingRaw = num(snapshot.quota_remaining) ?? num(snapshot.remaining);
  const usedRaw = num(snapshot.credits_used);
  const remaining = remainingRaw ?? (usedRaw !== undefined ? limit - usedRaw : undefined);
  if (remaining === undefined || !Number.isFinite(remaining)) return null;
  const used = usedRaw ?? limit - remaining;
  if (!Number.isFinite(used)) return null;

  const resetAt = parseTs(root.quota_reset_date_utc ?? root.quota_reset_date);
  if (resetAt === undefined) return null;
  const state: QuotaState = {
    window: "monthly",
    limit,
    remaining: clamp(remaining, 0, limit),
    resetAt,
    rateSamples: [],
  };
  const advice = computeAdvice(state, now);
  const plan = formatPlanName(root.copilot_plan);
  return {
    form: "subscription",
    provider: "github",
    label: plan ? `GitHub Copilot ${plan}` : "GitHub Copilot",
    level: advice.level,
    pacing: "",
    cardTiming: "",
    autoResetIn: advice.autoResetIn,
    sustainableRate: advice.sustainableRate,
    actualVsSustainable: advice.actualVsSustainable,
    projectedCapHitAt: advice.projectedCapHitAt,
    used: Math.max(0, used),
    remaining: clamp(remaining, 0, limit),
    limit,
    unit: "AI credits",
  };
}

function selectCreditSnapshot(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const snapshots = raw as Record<string, unknown>;
  const preferred = snapshots.premium_interactions;
  if (preferred && typeof preferred === "object") return preferred as Record<string, unknown>;
  return Object.values(snapshots).find(value => {
    if (!value || typeof value !== "object") return false;
    const snapshot = value as Record<string, unknown>;
    return snapshot.unlimited !== true && (num(snapshot.entitlement) ?? 0) > 0;
  }) as Record<string, unknown> | undefined;
}

function formatPlanName(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) return "";
  const value = raw.trim().toLowerCase().replace(/^individual_/, "").replace(/_/g, " ");
  if (value === "pro plus") return "Pro+";
  return value.replace(/\b\w/g, character => character.toUpperCase());
}

function readOAuthToken(credentialsPath?: string): string | undefined {
  const path = credentialsPath
    ?? join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "github-copilot", "apps.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    const tokens: string[] = [];
    collectOAuthTokens(parsed, tokens);
    return tokens.at(-1);
  } catch {
    return undefined;
  }
}

function collectOAuthTokens(value: unknown, tokens: string[]): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectOAuthTokens(item, tokens);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "oauth_token" && typeof child === "string" && child.trim()) tokens.push(child);
    else collectOAuthTokens(child, tokens);
  }
}

async function fetchJson(fetchImpl: typeof fetch, url: string, token: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return response.json().catch(() => null);
  } finally {
    clearTimeout(timeout);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
