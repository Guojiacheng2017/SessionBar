import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { ResetCard } from "./quota-engine/types.js";

interface WhamAdapterOptions {
  authJsonPath?: string;
  fetchImpl?: typeof fetch;
}

interface WhamCredit {
  id?: string;
  status?: string;
  expires_at?: number | string;
}

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Read Codex auth from ~/.codex/auth.json (or CODX_HOME / explicit path),
 * query the wham rate-limit-reset-credits API, and return one ResetCard per
 * available, unexpired credit. Any failure — missing auth file, missing token,
 * HTTP error, network error, malformed body — degrades to [].
 *
 * Accepts both the legacy bare-array body and the real object shape
 * `{ available_count, credits: [{ expires_at, status? }] }`. expires_at may be
 * an ISO string, epoch seconds (<1e12), or epoch milliseconds; non-parseable
 * or already-expired credits are dropped.
 */
export async function fetchResetCards(opts: WhamAdapterOptions = {}): Promise<ResetCard[]> {
  try {
    const authPath = opts.authJsonPath ?? join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
    if (!existsSync(authPath)) return [];
    const auth = JSON.parse(readFileSync(authPath, "utf-8"));
    const token = auth?.tokens?.access_token;
    const accountId = auth?.account_id;
    if (!token) return [];

    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const resp = await fetchImpl("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", {
        headers: {
          Authorization: `Bearer ${token}`,
          ...(accountId ? { "ChatGPT-Account-Id": String(accountId) } : {}),
        },
        signal: controller.signal,
      });
      if (!resp.ok) return [];
      const body = await resp.json().catch(() => []);
      const credits = extractCredits(body);

      const now = Date.now();
      const cards: ResetCard[] = [];
      for (const c of credits) {
        if (!c || typeof c !== "object") continue;
        const expiresAt = parseExpiresAt((c as WhamCredit).expires_at);
        if (expiresAt === undefined || expiresAt <= now) continue;
        cards.push({ count: 1, expiresAt });
      }
      return cards;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return [];
  }
}

function extractCredits(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object" && Array.isArray((body as { credits?: unknown }).credits)) {
    return (body as { credits: unknown[] }).credits;
  }
  return [];
}

function parseExpiresAt(value: unknown): number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
