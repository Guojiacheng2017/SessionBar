import { stripVTControlCharacters } from "node:util";
import { stripAnsi } from "./displayUtils.js";

export function terminalText(value: unknown): string {
  return stripVTControlCharacters(String(value ?? "")).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replace(/\t/g, "    ");
}

export function wrapTerminalText(value: unknown, width: number): string {
  const limit = Math.max(1, Math.floor(width));
  return terminalText(value).split("\n").flatMap(paragraph => {
    const lines: string[] = [];
    let line = "", used = 0;
    for (const char of paragraph) {
      const size = stripAnsi(char);
      if (used + size > limit && line) { lines.push(line); line = ""; used = 0; }
      if (size > limit) continue;
      line += char; used += size;
    }
    lines.push(line);
    return lines;
  }).join("\n");
}
