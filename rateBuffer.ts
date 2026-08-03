import type { RateSample } from "./quota-engine/types.js";

const MS_PER_HOUR = 3_600_000;

export class RateBuffer {
  private entries: RateSample[] = [];
  private lastUsed: number | undefined;
  private lastAt: number | undefined;

  constructor(private readonly maxSize = 20) {}

  record(used: number, now: number): void {
    if (this.lastUsed !== undefined && this.lastAt !== undefined && now > this.lastAt) {
      const delta = used - this.lastUsed;
      if (delta > 0) {
        const hours = (now - this.lastAt) / MS_PER_HOUR;
        this.entries.push({ value: (delta / hours), at: now });
        if (this.entries.length > this.maxSize) this.entries.shift();
      }
    }
    this.lastUsed = used;
    this.lastAt = now;
  }

  samples(): RateSample[] {
    return [...this.entries];
  }
}
