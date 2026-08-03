import { test } from "node:test";
import assert from "node:assert/strict";
import { RateBuffer } from "../dist/rateBuffer.js";

test("records rate from used delta over elapsed hours", () => {
  const buf = new RateBuffer();
  buf.record(100_000, 1_000_000);
  buf.record(130_000, 1_900_000); // +30k over 0.25h → 120k/hr
  const samples = buf.samples();
  assert.equal(samples.length, 1);
  assert.ok(Math.abs(samples[0].value - 120_000) < 1);
});

test("skips zero delta (no consumption)", () => {
  const buf = new RateBuffer();
  buf.record(100_000, 1_000_000);
  buf.record(100_000, 1_900_000); // used unchanged → no sample
  assert.equal(buf.samples().length, 0);
});

test("cold start (first record) produces no sample", () => {
  const buf = new RateBuffer();
  buf.record(100_000, 1_000_000);
  assert.equal(buf.samples().length, 0);
});

test("caps buffer at max size (FIFO)", () => {
  const buf = new RateBuffer(5);
  for (let i = 0; i < 10; i++) {
    buf.record(10_000 * (i + 1), 1_000_000 + i * 1_000);
  }
  assert.equal(buf.samples().length, 5);
});
