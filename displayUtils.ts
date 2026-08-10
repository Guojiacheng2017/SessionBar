// Shared display utilities — used by cli.ts (menu/status), openTuiMonitor.ts (TUI),
// and sessionInspector.ts (detail panels). Keep these pure and allocation-light.

/** Human-readable age string for a timestamp relative to now. */
export function age(timestamp: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - (timestamp || now)) / 1000));
  if (seconds < 10) return "now";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

/** Compact human-readable number: 1.2M, 800K, 42. */
export function compactNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${trimZero((value / 1_000_000_000).toFixed(1))}B`;
  if (abs >= 1_000_000) return `${trimZero((value / 1_000_000).toFixed(1))}M`;
  if (abs >= 1_000) return `${trimZero((value / 1_000).toFixed(1))}K`;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function trimZero(text: string): string {
  return text.replace(/\.0$/, "");
}

/** Truncate plain text to max chars, appending "…" if needed. */
export function truncatePlain(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 3) return text.slice(0, max);
  return `${text.slice(0, max - 3)}...`;
}

/** Format context percentage from raw value (0-1 or 0-100). */
export function contextPercent(raw: number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  return Math.max(0, Math.min(100, raw <= 1 && raw >= 0 ? raw * 100 : raw));
}

/** Compact agent type name: strip " Code"/" CLI" suffixes. */
export function agentName(type: string): string {
  return (type || "?").replace(/\s+Code$/i, "").replace(/\s+CLI$/i, "").replace(/\s+/g, " ");
}

export interface SessionDisplayNameInput {
  session_name?: string;
  project?: string;
  project_path?: string;
  session_id?: string;
}

/** Prefer a reported session name, then the project name, then the raw session id. */
export function sessionDisplayName(session: SessionDisplayNameInput): string {
  const name = session.session_name?.trim();
  if (name) return name;

  const project = session.project?.trim();
  if (project) return project;

  const projectPath = session.project_path?.trim().replace(/[\\/]+$/, "");
  if (projectPath) {
    const basename = projectPath.split(/[\\/]/).pop()?.trim();
    if (basename) return basename;
  }

  const encodedProject = session.session_id?.split("__")[1]?.trim();
  if (encodedProject) return encodedProject;

  return session.session_id?.trim() || "?";
}

/** Short status label for display: WORK / WAIT / ERR / IDLE. */
export function statusLabel(status: string): string {
  if (status === "working") return "WORK";
  if (status === "blocked") return "WAIT";
  if (status === "error") return "ERR";
  return "IDLE";
}

/** First finite number from variadic arguments. */
export function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** Clamp a number to [min, max]. */
export function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Visible length of a string after stripping ANSI escape sequences. */
export function stripAnsi(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/**
 * Truncate a string with ANSI escape sequences to a visible-width limit.
 * Appends "…" and an optional ANSI reset code after the ellipsis so that
 * the truncated text does not bleed its color into surrounding content.
 */
export function truncateAnsi(s: string, max: number, reset = ""): string {
  if (max <= 0) return "";
  if (stripAnsi(s) <= max) return s;
  let out = "";
  let visible = 0;
  for (let i = 0; i < s.length && visible < Math.max(0, max - 1); i++) {
    if (s[i] === "\x1b" && s[i + 1] === "[") {
      const end = s.indexOf("m", i);
      if (end === -1) break;
      out += s.slice(i, end + 1);
      i = end;
      continue;
    }
    out += s[i];
    visible++;
  }
  return out + "…" + reset;
}
