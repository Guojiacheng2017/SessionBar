import { setTimeout as delay } from "node:timers/promises";
import { TERMINAL_COLORS } from "./terminalTheme.js";
import { WORDMARK_MASK_HEIGHT, WORDMARK_MASK_HEX, WORDMARK_MASK_WIDTH } from "./wordmarkMask.js";

const mask = Buffer.from(WORDMARK_MASK_HEX, "hex");
const dots = [[1, 8], [2, 16], [4, 32], [64, 128]] as const;
const INTRO_FRAMES = 36;
const INTRO_FRAME_MS = 50;
const brand = TERMINAL_COLORS.brand.map(hex => [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16)));

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

// Move a continuous palette field inside the fixed ink, then let the field
// and diagonal glint settle back to the Logo's left-to-right gradient.
function brandInk(x: number, y: number, progress: number): string {
  const flow = clamp((progress - 0.18) / 0.82);
  const strength = flow > 0 && flow < 1 ? Math.sin(Math.PI * flow) ** 2 : 0;
  const drift = Math.sin((x * 0.7 - flow * 1.35) * Math.PI * 2 + y * 0.5);
  const position = clamp(x + 0.22 * strength * drift) * (brand.length - 1);
  const left = Math.floor(position);
  const right = Math.min(brand.length - 1, left + 1);
  const fraction = position - left;
  const distance = Math.abs(x + y * 0.12 - (-0.3 + flow * 1.6));
  const band = clamp(1 - distance / 0.18);
  const shine = band * band * (3 - 2 * band) * strength * 0.32;
  const shade = 0.94 + 0.06 * (1 - y);
  const rgb = brand[left]!.map((value, channel) => {
    const ink = (value + (brand[right]![channel]! - value) * fraction) * shade;
    return Math.round(ink + (255 - ink) * shine);
  });
  return `\x1b[38;2;${rgb.join(";")}m`;
}

function sourcePixel(x: number, y: number): boolean {
  if (x < 0 || x >= WORDMARK_MASK_WIDTH || y < 0 || y >= WORDMARK_MASK_HEIGHT) return false;
  const index = y * WORDMARK_MASK_WIDTH + x;
  return Boolean(mask[index >> 3]! & (128 >> (index & 7)));
}

// Expand the ink by one source pixel, once. This gives the dots weight even
// when the terminal's fallback font has no bold Braille glyphs.
const weightedMask = Uint8Array.from({ length: WORDMARK_MASK_WIDTH * WORDMARK_MASK_HEIGHT }, (_, index) => {
  const x = index % WORDMARK_MASK_WIDTH;
  const y = Math.floor(index / WORDMARK_MASK_WIDTH);
  return Number(sourcePixel(x, y) || sourcePixel(x - 1, y) || sourcePixel(x + 1, y)
    || sourcePixel(x, y - 1) || sourcePixel(x, y + 1));
});

function pixel(x: number, y: number): boolean {
  if (x < 0 || x >= WORDMARK_MASK_WIDTH || y < 0 || y >= WORDMARK_MASK_HEIGHT) return false;
  return Boolean(weightedMask[y * WORDMARK_MASK_WIDTH + x]);
}

export function terminalWordmark(width: number, rainbow: readonly string[], reset: string, progress = 1): string[] {
  const columns = Math.max(1, Math.floor(width) - 4);
  const pixelHeight = Math.round(columns * 2 * WORDMARK_MASK_HEIGHT / WORDMARK_MASK_WIDTH);
  const rows = Math.ceil(pixelHeight / 4);
  const padding = Math.floor((rows * 4 - pixelHeight) / 2);
  const progressValue = clamp(progress);
  const settled = clamp(progressValue / 0.28);
  const colorEnabled = Boolean(reset) && rainbow.some(Boolean);
  const lines: string[] = [];
  for (let row = 0; row < rows; row++) {
    let line = "  ";
    let previousColor = "";
    for (let column = 0; column < columns; column++) {
      const phase = Math.max(0, Math.min(1, (settled - column / columns * 0.28) / 0.72));
      const offset = Math.round(8 * (1 - phase) ** 3);
      let bits = 0;
      if (phase > 0) {
        for (let dy = 0; dy < 4; dy++) {
          const y = Math.floor((row * 4 + dy - padding - offset) * WORDMARK_MASK_HEIGHT / pixelHeight);
          for (let dx = 0; dx < 2; dx++) {
            const x = Math.floor((column * 2 + dx) * WORDMARK_MASK_WIDTH / (columns * 2));
            if (pixel(x, y)) bits |= dots[dy]![dx]!;
          }
        }
      }
      const color = colorEnabled && bits
        ? brandInk(column / Math.max(1, columns - 1), row / Math.max(1, rows - 1), progressValue)
        : "";
      if (bits && color !== previousColor) {
        line += color;
        previousColor = color;
      }
      line += bits ? String.fromCodePoint(0x2800 + bits) : " ";
    }
    lines.push(`${line}${reset}`);
  }
  return lines;
}

// A finite intro, not a background animation. Any queued menu input skips to
// the final frame so launching a command never waits for the logo to finish.
export async function playWordmarkIntro(
  render: (progress: number) => void,
  interrupted: () => boolean,
): Promise<void> {
  for (let frame = 1; frame < INTRO_FRAMES; frame++) {
    if (interrupted()) break;
    await delay(INTRO_FRAME_MS);
    if (interrupted()) break;
    render(frame / INTRO_FRAMES);
  }
  render(1);
}

// A slow 12-second ambient cycle. The caller owns cancellation when the menu
// loses control of the terminal; no session or server polling is involved.
export function startWordmarkLoop(render: (frame: number) => void, initialFrame = 0): () => void {
  let frame = initialFrame;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const tick = () => {
    if (stopped) return;
    frame = (frame + 1) % 48;
    render(frame);
    if (!stopped) timer = setTimeout(tick, 250);
  };
  timer = setTimeout(tick, 250);
  return () => { stopped = true; clearTimeout(timer); };
}
