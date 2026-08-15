import type { RateMethod, RateSample } from "./types.js";

export function estimateRate(
  samples: RateSample[],
  method: RateMethod = "sma",
  maWindow = 5,
): number {
  if (samples.length < 2) return 0;
  // sort by timestamp ascending so windowing/fitting always sees chronological order
  const sorted = [...samples].sort((a, b) => a.at - b.at);
  const window = Math.max(2, Math.min(maWindow, sorted.length));
  const recent = sorted.slice(-window);
  switch (method) {
    case "ema":
      return ema(recent);
    case "median":
      return median(recent.map(s => s.value));
    case "linear":
      return linearFit(recent);
    case "sma":
    default:
      return recent.reduce((sum, s) => sum + s.value, 0) / recent.length;
  }
}

function ema(samples: RateSample[]): number {
  const k = 2 / (samples.length + 1);
  let prev = samples[0]!.value;
  for (let i = 1; i < samples.length; i++) {
    prev = samples[i]!.value * k + prev * (1 - k);
  }
  return prev;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function linearFit(samples: RateSample[]): number {
  const n = samples.length;
  // x in seconds → fit value (tokens/hour) vs time, then evaluate the fitted
  // line at the newest timestamp = the predicted current rate in tokens/hour.
  const x = samples.map(s => s.at / 1000);
  const y = samples.map(s => s.value);
  const xMean = x.reduce((a, b) => a + b, 0) / n;
  const yMean = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i]! - xMean) * (y[i]! - yMean);
    den += (x[i]! - xMean) ** 2;
  }
  if (den === 0) return yMean; // constant timestamps → flat line at mean value
  const slope = num / den;
  const intercept = yMean - slope * xMean;
  return intercept + slope * (samples[n - 1]!.at / 1000);
}
