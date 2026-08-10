// Shared utilities for provider-plan adapters. Each adapter previously
// duplicated these 3 helpers; extracting them eliminates ~30 lines of
// identical code.

/** Coerce unknown → number | undefined. Handles number and numeric-string inputs. */
export function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") { const n = Number(v); return Number.isFinite(n) ? n : undefined; }
  return undefined;
}

/**
 * Parse a timestamp from unknown input.
 * - Number < 1e12 → treated as Unix seconds (multiply by 1000)
 * - Number >= 1e12 → treated as Unix milliseconds
 * - String → try Number coercion, then Date.parse
 */
export function parseTs(v: unknown): number | undefined {
  if (typeof v === "number") return v < 1_000_000_000_000 ? v * 1000 : v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n < 1_000_000_000_000 ? n * 1000 : n;
    const d = Date.parse(v);
    return Number.isFinite(d) ? d : undefined;
  }
  return undefined;
}

/** Safe nested object access: obj?.key when obj may be undefined. */
export function sub(obj: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const v = obj?.[key];
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}
