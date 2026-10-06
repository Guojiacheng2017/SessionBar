import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateState } from "../shared/privateState.js";

export interface SessionBarSettings {
  /** Spend the nearest OpenAI/Codex reset card when it has <= 5 minutes left. */
  autoConsumeResetCards: boolean;
}

export function defaultSettings(): SessionBarSettings {
  return { autoConsumeResetCards: false };
}

function settingsPath(home: string): string {
  return join(home, "settings.json");
}

export function readSettings(home: string): SessionBarSettings {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(home), "utf8")) as Record<string, unknown>;
    return { autoConsumeResetCards: raw.autoConsumeResetCards === true };
  } catch {
    return defaultSettings();
  }
}

export function updateSettings(
  home: string,
  patch: Partial<SessionBarSettings>,
): SessionBarSettings {
  const next = {
    ...readSettings(home),
    ...patch,
  };
  const path = settingsPath(home);
  writePrivateState(path, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function disableAutoConsumeResetCards(home: string): SessionBarSettings {
  return updateSettings(home, { autoConsumeResetCards: false });
}
