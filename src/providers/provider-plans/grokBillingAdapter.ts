import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PlanRow } from "../planTypes.js";
import { computeAdvice } from "../quota-engine/quotaEngine.js";
import { providerChildEnv, trackProviderChild } from "../../runtime/networkRuntime.js";

const POLL_MS = 15 * 60_000;
let nextPoll = 0;
let inFlight: Promise<PlanRow | null> | undefined;
let lastFailure: PlanRow | null = null;
let lastIdentity: Pick<PlanRow, "provider" | "label"> = { provider: "grok", label: "Grok Billing" };

export function parseGrokBilling(body: unknown, now = Date.now()): PlanRow | null {
  const config = (body as any)?.config;
  const used = config?.creditUsagePercent;
  const resetAt = Date.parse(config?.currentPeriod?.end ?? "");
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100 || !Number.isFinite(resetAt) || resetAt <= now) return null;
  const remaining = 100 - used;
  const advice = computeAdvice({ window: "weekly", limit: 100, remaining, resetAt, rateSamples: [] }, now);
  return {
    ...advice,
    form: "subscription",
    provider: config.isUnifiedBillingUser === true ? "three-in-one" : "grok",
    label: config.isUnifiedBillingUser === true ? "Three-in-One Subscription" : "Grok Subscription",
    used, remaining, limit: 100, unit: "%", lastSeenAt: now,
  };
}

export async function fetchGrokSubscription(): Promise<PlanRow | null> {
  if (inFlight) return inFlight;
  const now = Date.now();
  // Return no new observation between polls: the runtime retains last-good
  // rows without renewing their collection timestamp.
  if (process.env.SESSIONBAR_GROK_BILLING === "0") return null;
  if (now < nextPoll) return lastFailure;
  const executable = process.env.SESSIONBAR_GROK_BIN || join(homedir(), ".grok", "bin", "grok");
  if (!existsSync(executable) || !existsSync(join(homedir(), ".grok", "auth.json"))) return null;
  nextPoll = now + POLL_MS;
  inFlight = queryBilling(executable).then(body => {
    const row = parseGrokBilling(body);
    if (row) { lastIdentity = row; lastFailure = null; return row; }
    return unavailable();
  }).catch(() => unavailable()).finally(() => { inFlight = undefined; });
  return inFlight;
}

function unavailable(): PlanRow {
  lastFailure = {
    provider: lastIdentity.provider, label: lastIdentity.label,
    form: "subscription", level: "yellow", pacing: "", cardTiming: "", autoResetIn: "",
    sustainableRate: 0, actualVsSustainable: null, projectedCapHitAt: null,
    stale: true, collectionError: "Query unavailable",
  };
  return lastFailure;
}

function queryBilling(executable: string): Promise<unknown> {
  return new Promise(resolve => {
    const child = spawn(executable, ["agent", "--no-leader", "stdio"], {
      stdio: ["pipe", "pipe", "ignore"], env: providerChildEnv(),
    });
    const untrack = trackProviderChild(child);
    child.once("close", untrack);
    let buffer = "";
    let bytes = 0;
    let settled = false;
    const finish = (value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      const reap = setTimeout(() => child.kill("SIGKILL"), 1_000);
      reap.unref();
      child.once("exit", () => clearTimeout(reap));
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 15_000);
    const send = (id: number, method: string, params: unknown) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    child.stdin.on("error", () => finish(null));
    child.on("error", () => finish(null));
    child.on("exit", () => finish(null));
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1_048_576) { finish(null); return; }
      buffer += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.id === 1) {
            if (message.error) finish(null);
            else send(2, "_x.ai/billing", {});
          } else if (message.id === 2) finish(message.result ?? null);
        } catch { /* Ignore non-protocol output; never log credentials. */ }
      }
    });
    send(1, "initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "sessionbar-billing", version: "1" } });
  });
}
