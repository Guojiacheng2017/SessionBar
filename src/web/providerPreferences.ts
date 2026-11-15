import type { PlanRow } from "../providers/planTypes.js";

export const PROVIDER_FREQUENCY_STORAGE_KEY = "sessionbar:infrequent-providers";
export const PROVIDER_VIEW_STORAGE_KEY = "sessionbar:provider-view";
export type ProviderView = "frequent" | "all";

export function readProviderView(storage: Pick<Storage, "getItem">): ProviderView {
  try { return storage.getItem(PROVIDER_VIEW_STORAGE_KEY) === "all" ? "all" : "frequent"; }
  catch { return "frequent"; }
}

export function saveProviderView(storage: Pick<Storage, "setItem">, view: ProviderView): boolean {
  try { storage.setItem(PROVIDER_VIEW_STORAGE_KEY, view); return true; }
  catch { return false; }
}

export function providerPreferenceKey(row: Pick<PlanRow, "provider" | "form" | "label">): string {
  return JSON.stringify([row.provider, row.form, row.label]);
}

export function readInfrequentProviders(storage: Pick<Storage, "getItem">): Set<string> {
  try {
    return parsePreferences(storage.getItem(PROVIDER_FREQUENCY_STORAGE_KEY));
  } catch {
    return new Set();
  }
}

export function saveInfrequentProviders(storage: Pick<Storage, "setItem">, keys: ReadonlySet<string>): boolean {
  try {
    storage.setItem(PROVIDER_FREQUENCY_STORAGE_KEY, JSON.stringify([...keys]));
    return true;
  } catch {
    return false;
  }
}

function parsePreferences(raw: string | null): Set<string> {
  try {
    const value: unknown = JSON.parse(raw || "[]");
    return new Set(Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : []);
  } catch {
    return new Set();
  }
}

export function updateProviderFrequency(
  storage: Pick<Storage, "getItem" | "setItem">,
  key: string,
  frequent: boolean,
  current: ReadonlySet<string>,
  refreshFromStorage = true,
): { infrequentProviders: Set<string>; persisted: boolean } {
  let next = new Set(current);
  // Do not reload stale storage while unsaved local choices are pending.
  if (refreshFromStorage) {
    try { next = parsePreferences(storage.getItem(PROVIDER_FREQUENCY_STORAGE_KEY)); } catch { /* retain in-memory choices */ }
  }
  if (frequent) next.delete(key);
  else next.add(key);
  return { infrequentProviders: next, persisted: saveInfrequentProviders(storage, next) };
}
