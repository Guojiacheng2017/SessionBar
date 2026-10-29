export const LANDING_COMMANDS = ["monitor", "sessions", "providers", "agents", "setup", "status", "settings", "web", "refresh", "harnesses", "help", "quit"] as const;
export type LandingCommand = Exclude<typeof LANDING_COMMANDS[number], "sessions">;

export function resolveLandingCommand(value: string): LandingCommand | null {
  const name = value.trim().replace(/^[:/]/, "").trim().toLowerCase();
  const aliases: Record<string, LandingCommand> = { sessions: "monitor", watch: "monitor", w: "web", r: "refresh", q: "quit", exit: "quit", "1": "monitor", "2": "setup", "3": "status", "4": "settings" };
  return Object.hasOwn(aliases, name) ? aliases[name]! : (LANDING_COMMANDS.includes(name as typeof LANDING_COMMANDS[number]) ? name as LandingCommand : null);
}

/** Small built-in command editor; it never passes text to a shell. */
export class LandingCommandInput {
  active = false;
  value = "";
  private cursor = 0;
  private history: string[] = [];
  private historyIndex = 0;
  private escape = "";

  feed(raw: string): string[] {
    const events: string[] = [];
    let changed = false;
    const text = this.escape + raw;
    this.escape = "";
    for (let i = 0; i < text.length; i++) {
      let key = text[i]!;
      if (key === "\x1b" && i + 1 < text.length) {
        const sequence = /^\x1b(?:\[[\d;]*[A-Za-z~]|O[A-Z])/.exec(text.slice(i));
        if (sequence) { key = sequence[0]; i += key.length - 1; }
        else if (/^\x1b(?:\[[\d;]*|O)$/.test(text.slice(i))) { this.escape = text.slice(i); break; }
      }
      if (!this.active) {
        if (key === ":" || key === "/" || key === "\t") {
          this.active = true; this.value = ""; this.cursor = 0; this.historyIndex = this.history.length; changed = true;
        } else if (key === "\x1b[A" || key === "\x1bOA" || key === "k" || key === "K") events.push("up");
        else if (key === "\x1b[B" || key === "\x1bOB" || key === "j" || key === "J") events.push("down");
        else if (key === "\x03") events.push("q");
        else if (key === "\r" || key === "\n") events.push("enter");
        else if ("1234qrRwW".includes(key)) events.push(key.toLowerCase());
        continue;
      }
      changed = true;
      if (key === "\x1b" || key === "\x03") {
        this.active = false; this.value = ""; this.cursor = 0;
        if (key === "\x03") events.push("q");
      } else if (key === "\r" || key === "\n") {
        const value = this.value.trim();
        if (value) {
          if (this.history.at(-1) !== value) this.history.push(value);
          this.history = this.history.slice(-30);
          events.push(`command:${value}`);
        }
        this.value = ""; this.cursor = 0; this.active = false;
      } else if (key === "\x1b[D") this.cursor = Math.max(0, this.cursor - 1);
      else if (key === "\x1b[C") this.cursor = Math.min(this.value.length, this.cursor + 1);
      else if (key === "\x01" || key === "\x1b[H" || key === "\x1b[1~") this.cursor = 0;
      else if (key === "\x05" || key === "\x1b[F" || key === "\x1b[4~") this.cursor = this.value.length;
      else if (key === "\x15") { this.value = this.value.slice(this.cursor); this.cursor = 0; }
      else if (key === "\x7f" || key === "\b") {
        if (this.cursor > 0) { this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor); this.cursor--; }
      } else if (key === "\x1b[3~") this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1);
      else if (key === "\x1b[A" || key === "\x1b[B") {
        this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + (key === "\x1b[A" ? -1 : 1)));
        this.value = this.history[this.historyIndex] ?? ""; this.cursor = this.value.length;
      } else if (key === "\t") {
        const matches = LANDING_COMMANDS.filter(command => command.startsWith(this.value.toLowerCase()));
        if (matches.length === 1) { this.value = matches[0]!; this.cursor = this.value.length; }
      } else if (key.length === 1 && key >= " " && key <= "~" && this.value.length < 256) {
        this.value = this.value.slice(0, this.cursor) + key + this.value.slice(this.cursor); this.cursor++;
      }
    }
    if (changed && !events.some(event => event.startsWith("command:"))) events.push("input");
    return events;
  }

  display(width: number): string {
    const budget = Math.max(1, width - 2);
    const offset = Math.max(0, this.cursor - budget + 1);
    const value = this.value.slice(0, this.cursor) + (this.active ? "_" : "") + this.value.slice(this.cursor);
    return `> ${value.slice(offset, offset + budget)}`.slice(0, width);
  }
}
