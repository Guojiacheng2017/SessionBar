import { TERMINAL_COLORS } from "./terminalTheme.js";
import { WORDMARK_MASK_HEX } from "./wordmarkMask.js";

export interface ParticleFrame {
  width: number;
  height: number;
  pixels: Buffer;
}

const mask = Buffer.from(WORDMARK_MASK_HEX, "hex");
const RASTER_SCALE = 2;
const palette = TERMINAL_COLORS.brand.map(hex => [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)));
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const mix = (a: number[], b: number[], t: number) => a.map((value, i) => value + (b[i]! - value) * t);
const smooth = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };
const hash = (x: number, y: number) => { const n = Math.sin(x * 127.1 + y * 311.7 + 17.4) * 43758.5453; return n - Math.floor(n); };

function sample(x: number, y: number): number {
  x = Math.floor(x); y = Math.floor(y);
  if (x < 0 || y < 0 || x >= 256 || y >= 44) return 0;
  const index = y * 256 + x;
  return mask[index >> 3]! & (128 >> (index & 7)) ? 1 : 0;
}

// Keep opaque cores and a subpixel antialiasing edge. A 2x raster
// avoids enlarging soft, low-resolution grains on high-density displays.
function circle(frame: ParticleFrame, cx: number, cy: number, radius: number, color: number[]): void {
  if (radius <= 0) return;
  cx *= RASTER_SCALE;
  cy *= RASTER_SCALE;
  radius *= RASTER_SCALE;
  for (let y = Math.max(0, Math.floor(cy - radius - 1)); y <= Math.min(frame.height - 1, Math.ceil(cy + radius + 1)); y++) {
    for (let x = Math.max(0, Math.floor(cx - radius - 1)); x <= Math.min(frame.width - 1, Math.ceil(cx + radius + 1)); x++) {
      const alpha = clamp((radius - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)) / 0.75 + 0.5);
      if (!alpha) continue;
      const index = (y * frame.width + x) * 4;
      const previous = frame.pixels[index + 3]! / 255;
      const combined = alpha + previous * (1 - alpha);
      for (let channel = 0; channel < 3; channel++) {
        frame.pixels[index + channel] = Math.round((color[channel]! * alpha + frame.pixels[index + channel]! * previous * (1 - alpha)) / combined);
      }
      frame.pixels[index + 3] = Math.round(combined * 255);
    }
  }
}

export function createParticleWordmark(columns: number, rows: number, cell: { width: number; height: number }) {
  const scale = Math.min(1, 1536 / (columns * cell.width), 512 / (rows * cell.height));
  const width = Math.max(1, Math.round(columns * cell.width * scale));
  const height = Math.max(1, Math.round(rows * cell.height * scale));
  const inkWidth = Math.min(width * 0.94, Math.max(1, height - 6) * 256 / 44);
  const inkHeight = inkWidth * 44 / 256;
  const pitch = inkWidth / 112;
  const originX = (width - inkWidth) / 2, originY = (height - inkHeight) / 2;
  const points: { x: number; y: number; u: number; v: number; ink: number; seed: number }[] = [];
  for (let row = 0; row < Math.ceil(inkHeight / pitch); row++) {
    for (let column = 0; column < 112; column++) {
      const x = (column + 0.5) * pitch, y = (row + 0.5) * pitch;
      let ink = 0;
      for (const dy of [-0.65, 0, 0.65]) for (const dx of [-0.65, 0, 0.65]) ink += sample(x / inkWidth * 256 + dx, y / inkHeight * 44 + dy);
      ink /= 9;
      if (ink >= 0.34) points.push({ x: originX + x, y: originY + y, u: x / inkWidth, v: y / inkHeight, ink, seed: hash(column, row) });
    }
  }

  function render(progress = 1, light = false, steady = false): ParticleFrame {
      const t = clamp(progress);
      const frame = {
        width: width * RASTER_SCALE,
        height: height * RASTER_SCALE,
        pixels: Buffer.alloc(width * height * RASTER_SCALE ** 2 * 4),
      };
      const strength = Math.sin(t * Math.PI) ** 2;
      for (const point of points) {
        const drift = Math.sin((point.u * 0.7 - t * 1.35) * Math.PI * 2 + point.v * 0.5);
        const location = clamp(point.u + 0.18 * strength * drift) * (palette.length - 1);
        const index = Math.floor(location);
        const base = mix(palette[index]!, palette[Math.min(index + 1, palette.length - 1)]!, location - index);
        const beam = Math.exp(-(((point.u + point.v * 0.13 - (-0.2 + t * 1.4)) / 0.13) ** 2)) * strength;
        const broad = (Math.sin(point.u * 21 + point.v * 3.3) + Math.cos(point.v * 12 - point.u * 9) + 2) / 4;
        const level = clamp(0.29 + point.seed * 0.33 + broad * 0.35 + beam * 0.28);
        const radius = Math.min(pitch * 0.46 - 0.4, pitch * (0.12 + 0.34 * level ** 1.6) * (0.83 + point.ink * 0.17));
        const forming = steady ? 1 : smooth((t * 7 - point.u * 0.55) / 0.7);
        let color = base;
        if (light) color = mix(base, base.map(channel => channel * 0.74), 0.12 + 0.2 * level);
        else color = mix(base, [255, 239, 217], Math.max(0, (level - 0.72) / 0.28) * 0.68);
        circle(frame, point.x, point.y + (1 - forming) ** 3 * pitch * 1.4, radius * forming, color);
      }
      return frame;
  }
  return {
    render,
    renderLoop(phase: number, light = false): ParticleFrame {
      return render(((phase % 1) + 1) % 1, light, true);
    },
  };
}
