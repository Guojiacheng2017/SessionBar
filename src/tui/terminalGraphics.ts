import { randomInt } from "node:crypto";
import { deflateSync } from "node:zlib";
import type { ParticleFrame } from "./particleWordmark.js";

export interface TerminalGraphicsInfo {
  cell: { width: number; height: number };
  light: boolean;
}

// Retain partial replies between reads, including late replies after a probe
// times out. Otherwise an "OK" response can become a menu's K/up command.
export class TerminalGraphicsReplies {
  private pending = "";
  private supported = false;
  private cell?: TerminalGraphicsInfo["cell"];
  private light = false;

  constructor(readonly imageId = randomInt(1, 0x7fffffff), private columns = 80, private rows = 24) {}

  query(): string {
    return `\x1b_Ga=q,i=${this.imageId},t=d,f=24,s=1,v=1;AAAA\x1b\\\x1b[16t\x1b[14t\x1b]11;?\x07`;
  }

  result(): TerminalGraphicsInfo | undefined {
    return this.supported && this.cell ? { cell: this.cell, light: this.light } : undefined;
  }

  flushBareEscape(): string {
    if (this.pending !== "\x1b") return "";
    this.pending = "";
    return "\x1b";
  }

  feed(chunk: string): string {
    let remaining = this.pending + chunk;
    this.pending = "";
    let input = "";
    while (remaining) {
      const escape = remaining.indexOf("\x1b");
      if (escape < 0) return input + remaining;
      input += remaining.slice(0, escape);
      remaining = remaining.slice(escape);
      if (remaining.startsWith("\x1b_G")) {
        const end = remaining.indexOf("\x1b\\", 3);
        if (end < 0) break;
        const reply = remaining.slice(3, end);
        if (new RegExp(`(?:^|,)i=${this.imageId}(?:,|;)`).test(reply)) this.supported = reply.slice(reply.indexOf(";") + 1) === "OK";
        remaining = remaining.slice(end + 2);
        continue;
      }
      if (remaining.startsWith("\x1b]11;")) {
        const terminator = /\x07|\x1b\\/.exec(remaining);
        if (!terminator) break;
        const color = /^rgb:([a-f\d]{1,4})\/([a-f\d]{1,4})\/([a-f\d]{1,4})$/i.exec(remaining.slice(5, terminator.index));
        if (color) {
          const rgb = color.slice(1).map(value => parseInt(value, 16) / (16 ** value.length - 1));
          this.light = rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722 > 0.55;
        }
        remaining = remaining.slice(terminator.index + terminator[0].length);
        continue;
      }
      const geometry = /^\x1b\[([46]);(\d+);(\d+)t/.exec(remaining);
      if (geometry) {
        const height = Number(geometry[2]) / (geometry[1] === "4" ? this.rows : 1);
        const width = Number(geometry[3]) / (geometry[1] === "4" ? this.columns : 1);
        if (width >= 4 && width <= 128 && height >= 8 && height <= 256 && (!this.cell || geometry[1] === "6")) this.cell = { width, height };
        remaining = remaining.slice(geometry[0].length);
        continue;
      }
      if (["\x1b_G", "\x1b]11;"].some(prefix => prefix.startsWith(remaining)) || /^\x1b\[(?:[46](?:;\d*){0,2})?$/.test(remaining)) break;
      input += remaining[0];
      remaining = remaining.slice(1);
    }
    this.pending = remaining.slice(0, 8192);
    return input;
  }
}

export function probeTerminalGraphics(
  replies: TerminalGraphicsReplies,
  input: Pick<NodeJS.ReadStream, "on" | "off">,
  output: Pick<NodeJS.WriteStream, "write">,
  onInput: (text: string) => void,
  timeoutMs = 150,
): Promise<TerminalGraphicsInfo | undefined> {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); input.off("data", onData); resolve(replies.result()); };
    const onData = (chunk: Buffer) => {
      const text = replies.feed(chunk.toString());
      if (text) { onInput(text); finish(); }
    };
    const timer = setTimeout(finish, timeoutMs);
    input.on("data", onData);
    try { output.write(replies.query()); } catch { finish(); }
  });
}

export function encodeKittyImage(frame: ParticleFrame, imageId: number, columns: number, rows: number): string {
  const encoded = deflateSync(frame.pixels, { level: 1 }).toString("base64");
  let result = "";
  for (let offset = 0; offset < encoded.length; offset += 4096) {
    const more = offset + 4096 < encoded.length ? 1 : 0;
    const header = offset === 0
      ? `a=T,f=32,o=z,s=${frame.width},v=${frame.height},i=${imageId},p=1,c=${columns},r=${rows},C=1,q=2,m=${more}`
      : `m=${more},q=2`;
    result += `\x1b_G${header};${encoded.slice(offset, offset + 4096)}\x1b\\`;
  }
  return result;
}

export function deleteKittyImage(imageId: number): string {
  return `\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`;
}
