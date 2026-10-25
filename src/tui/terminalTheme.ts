export const TERMINAL_COLORS = {
  accent: "#83a8dc",
  working: "#66c995",
  idle: "#a2abb8",
  blocked: "#dfb657",
  error: "#ed8379",
  muted: "#a2abb8",
  dim: "#596170",
  border: "#303846",
  cyan: "#68cfd8",
  brand: [
    "#cf655b", "#db6455", "#c8a34e", "#dda516", "#52b985",
    "#209a67", "#36b5b8", "#608ac7", "#ac65ad", "#bd619e",
  ],
} as const;

function rgb(hex: string): string {
  const value = hex.replace(/^#/, "");
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `\x1b[38;2;${red};${green};${blue}m`;
}

export function terminalAnsiTheme(enabled: boolean) {
  const color = (value: string) => enabled ? rgb(value) : "";
  return {
    bold: enabled ? "\x1b[1m" : "",
    reset: enabled ? "\x1b[0m" : "",
    accent: color(TERMINAL_COLORS.accent),
    working: color(TERMINAL_COLORS.working),
    idle: color(TERMINAL_COLORS.idle),
    blocked: color(TERMINAL_COLORS.blocked),
    error: color(TERMINAL_COLORS.error),
    muted: color(TERMINAL_COLORS.muted),
    rainbow: TERMINAL_COLORS.brand.map(color),
  } as const;
}
