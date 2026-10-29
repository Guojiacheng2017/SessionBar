import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { inflateSync } from "node:zlib";
import test from "node:test";

const particles = await import("../dist/tui/particleWordmark.js").catch(() => ({}));
const graphics = await import("../dist/tui/terminalGraphics.js").catch(() => ({}));

test("space outside the wordmark stays transparent without a background dot grid", () => {
  const logo = particles.createParticleWordmark(72, 7, { width: 14, height: 28 });
  for (const light of [false, true]) {
    for (const frame of [logo.render(0, light), logo.render(1, light), logo.renderLoop(0.5, light)]) {
      for (let y = 0; y < frame.height; y++) {
        for (let x = 0; x < 20; x++) {
          assert.equal(frame.pixels[(y * frame.width + x) * 4 + 3], 0);
          assert.equal(frame.pixels[(y * frame.width + frame.width - 1 - x) * 4 + 3], 0);
        }
      }
    }
    assert.ok(logo.render(0, light).pixels.every(value => value === 0));
  }
});

test("particle wordmark renders transparent RGBA with distinct round grain sizes", () => {
  assert.equal(typeof particles.createParticleWordmark, "function");
  const logo = particles.createParticleWordmark(72, 7, { width: 14, height: 28 });
  const frame = logo.render(0.55, false);
  assert.equal(frame.width, 2016);
  assert.equal(frame.height, 392);
  assert.equal(frame.pixels.length, frame.width * frame.height * 4);
  assert.equal(frame.pixels[3], 0, "the terminal background must remain visible");
  const sizes = [];
  const visited = new Set();
  for (let i = 0; i < frame.width * frame.height; i++) {
    if (frame.pixels[i * 4 + 3] < 128 || visited.has(i)) continue;
    const queue = [i];
    visited.add(i);
    for (let at = 0; at < queue.length; at++) {
      const index = queue[at];
      for (const next of [index - frame.width, index + frame.width, index - 1, index + 1]) {
        if (next < 0 || next >= frame.width * frame.height || visited.has(next)
          || frame.pixels[next * 4 + 3] < 128) continue;
        visited.add(next);
        queue.push(next);
      }
    }
    sizes.push(queue.length);
  }
  assert.ok(sizes.length > 750, `${sizes.length} separated foreground grains`);
  assert.ok(Math.max(...sizes) / Math.min(...sizes) > 4, "particle sizes must visibly differ");
  assert.ok(Math.max(...sizes) < 360, "grains must not merge into solid strokes");
});

test("small terminal cells use a high-density raster with opaque particle cores", () => {
  const logo = particles.createParticleWordmark(72, 7, { width: 7, height: 14 });
  for (const light of [false, true]) {
    const frame = logo.renderLoop(0.45, light);
    assert.equal(frame.width, 1008, "2x sampling avoids enlarging a low-resolution image");
    assert.equal(frame.height, 196);
    let core = 0, solid = 0;
    for (let i = 3; i < frame.pixels.length; i += 4) {
      if (frame.pixels[i] >= 128) core++;
      if (frame.pixels[i] >= 250) solid++;
    }
    assert.ok(solid / core > 0.7, "round particles need solid interiors, not translucent blur");
  }
});

test("particle frames move the color field and retain a stable footprint", () => {
  assert.equal(typeof particles.createParticleWordmark, "function");
  const logo = particles.createParticleWordmark(72, 7, { width: 14, height: 28 });
  const first = logo.render(0.45, false);
  const next = logo.render(0.7, false);
  assert.equal(first.pixels.length, next.pixels.length);
  assert.notDeepEqual(first.pixels, next.pixels);
  assert.deepEqual(logo.render(2, false), logo.render(1, false));
  assert.notDeepEqual(logo.render(1, true).pixels, logo.render(1, false).pixels);
});

test("particle loop is fully formed and joins its endpoints without a flash", () => {
  const logo = particles.createParticleWordmark(72, 7, { width: 14, height: 28 });
  assert.equal(typeof logo.renderLoop, "function");
  assert.deepEqual(logo.renderLoop(0, false), logo.render(1, false));
  assert.deepEqual(logo.renderLoop(1, false), logo.renderLoop(0, false));
  assert.notDeepEqual(logo.renderLoop(0.5, false), logo.renderLoop(0, false));
  const visible = frame => {
    let count = 0;
    for (let i = 3; i < frame.pixels.length; i += 4) if (frame.pixels[i] >= 128) count++;
    return count;
  };
  assert.ok(visible(logo.renderLoop(0.02, false)) > visible(logo.render(1, false)) * 0.8);
});

test("particle raster bounds memory at large terminal font sizes", () => {
  assert.equal(typeof particles.createParticleWordmark, "function");
  const frame = particles.createParticleWordmark(72, 7, { width: 60, height: 120 }).render(1, false);
  assert.ok(frame.width <= 3072);
  assert.ok(frame.pixels.length <= 3072 * 1024 * 4);
});

test("graphics replies are split safely without eating keyboard input", () => {
  assert.equal(typeof graphics.TerminalGraphicsReplies, "function");
  const replies = new graphics.TerminalGraphicsReplies(42, 80, 36);
  assert.equal(replies.feed("j\x1b_Gi=42;O"), "j");
  assert.equal(replies.feed("K\x1b\\\x1b[6;28;14t\x1b]11;rgb:ffff/ffff/ffff\x07\x1b[B"), "\x1b[B");
  assert.deepEqual(replies.result(), { cell: { width: 14, height: 28 }, light: true });
  assert.equal(replies.feed("w"), "w");
});

test("graphics require positive support and valid pixel geometry", () => {
  assert.equal(typeof graphics.TerminalGraphicsReplies, "function");
  const missing = new graphics.TerminalGraphicsReplies(42, 80, 36);
  missing.feed("\x1b[6;28;14t");
  assert.equal(missing.result(), undefined);
  missing.feed("\x1b_Gi=99;OK\x1b\\");
  assert.equal(missing.result(), undefined);
  missing.feed("\x1b_Gi=42;EINVAL:unsupported\x1b\\");
  assert.equal(missing.result(), undefined);
  const windowSize = new graphics.TerminalGraphicsReplies(42, 80, 36);
  windowSize.feed("\x1b_Gi=42;OK\x1b\\\x1b[4;1008;1120t");
  assert.deepEqual(windowSize.result()?.cell, { width: 14, height: 28 });
});

test("late fragmented replies never become menu commands", () => {
  assert.equal(typeof graphics.TerminalGraphicsReplies, "function");
  const replies = new graphics.TerminalGraphicsReplies(42, 80, 36);
  const packets = "\x1b_Gi=42;OK\x1b\\\x1b[6;28;14t\x1b]11;rgb:1111/1212/1515\x1b\\";
  let input = "";
  for (const ch of packets) input += replies.feed(ch);
  assert.equal(input, "");
  assert.equal(replies.result()?.light, false);
  assert.equal(replies.feed("2\r"), "2\r");
});

test("command input can release a bare Escape without releasing partial terminal replies", () => {
  const replies = new graphics.TerminalGraphicsReplies(42, 80, 36);
  replies.feed("\x1b");
  assert.equal(typeof replies.flushBareEscape, "function");
  assert.equal(replies.flushBareEscape(), "\x1b");
  assert.equal(replies.flushBareEscape(), "");
  replies.feed("\x1b_Gi=42;OK\x1b");
  assert.equal(replies.flushBareEscape(), "");
  assert.equal(replies.feed("\\"), "");
});

test("probe removes listeners after timeout and preserves early menu input", async () => {
  assert.equal(typeof graphics.probeTerminalGraphics, "function");
  const input = new EventEmitter();
  const output = { write: () => true };
  const keys = [];
  const replies = new graphics.TerminalGraphicsReplies(42, 80, 36);
  assert.equal(await graphics.probeTerminalGraphics(replies, input, output, text => keys.push(text), 5), undefined);
  assert.equal(input.listenerCount("data"), 0);
  const pending = graphics.probeTerminalGraphics(replies, input, output, text => keys.push(text), 50);
  input.emit("data", Buffer.from("j"));
  await pending;
  assert.deepEqual(keys, ["j"]);
  assert.equal(input.listenerCount("data"), 0);
});

test("Kitty frames use compressed RGBA, bounded chunks and quiet cursor-safe placement", () => {
  assert.equal(typeof graphics.encodeKittyImage, "function");
  const frame = { width: 20, height: 10, pixels: Buffer.alloc(800, 123) };
  const encoded = graphics.encodeKittyImage(frame, 42, 72, 7);
  const packets = [...encoded.matchAll(/\x1b_G([^;]*);([^\x1b]*)\x1b\\/g)];
  assert.match(packets[0][1], /a=T/);
  for (const key of ["f=32", "o=z", "C=1", "q=2", "i=42", "p=1", "c=72", "r=7"]) assert.ok(packets[0][1].includes(key));
  assert.ok(packets.every(packet => packet[2].length <= 4096));
  assert.deepEqual(inflateSync(Buffer.from(packets.map(packet => packet[2]).join(""), "base64")), frame.pixels);
  assert.match(graphics.deleteKittyImage(42), /a=d,d=I,i=42/);
  assert.doesNotMatch(graphics.deleteKittyImage(42), /d=A/);
});
