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
  expires_at?: number;
}

/**
 * Read Codex auth from ~/.codex/auth.json (or CODX_HOME / explicit path),
 * query the wham rate-limit-reset-credits API, and return one ResetCard per
 * available, unexpired credit. Any failure — missing auth file, missing token,
 * HTTP error, network error, malformed body — degrades to [].
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
    const resp = await fetchImpl("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", {
      headers: {
        Authorization: `Bearer ${token}`,
        ...(accountId ? { "ChatGPT-Account-Id": String(accountId) } : {}),
      },
    });
    if (!resp.ok) return [];
    const body = await resp.json().catch(() => []);
    if (!Array.isArray(body)) return [];

    const now = Date.now();
    return body
      .filter((c: any): c is WhamCredit => !!c && typeof c === "object" && c.status === "available")
      .filter((c: WhamCredit) => typeof c.expires_at === "number" && c.expires_at > now)
      .map((c: WhamCredit) => ({ count: 1, expiresAt: c.expires_at as number }));
  } catch {
    return [];
  }
}
