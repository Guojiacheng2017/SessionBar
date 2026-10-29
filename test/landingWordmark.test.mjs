import assert from "node:assert/strict";
import test from "node:test";
import { createRainbow, logoLines } from "../dist/cli/landingMenu.js";
import * as wordmark from "../dist/tui/wordmark.js";
const { playWordmarkIntro, terminalWordmark } = wordmark;

const plain = progress => logoLines(76, createRainbow(false), "", progress);
const colored = progress => logoLines(76, createRainbow(true), "\x1b[0m", progress).join("\n");
const withoutColor = text => text.replace(/\x1b\[[0-9;]*m/g, "");

test("large landing logo uses the outlined script rather than the old block font", () => {
  const lines = plain(1);
  assert.ok(lines.length >= 8 && lines.length <= 12);
  assert.match(lines.join("\n"), /[\u2801-\u28ff]/);
  assert.doesNotMatch(lines.join("\n"), /[█▀▄▌▐▖▗▘▙▚▛▜▝▞▟╔╗╚╝]|\x1b\[/);
  assert.ok(lines.every(line => [...line].length <= 76));
});

test("wordmark motion changes the contour without resizing its footprint", () => {
  const start = plain(0);
  const middle = plain(0.12);
  const final = plain(1);
  assert.notDeepEqual(middle, final);
  assert.equal(start.length, final.length);
  assert.deepEqual(start.map(line => [...line].length), final.map(line => [...line].length));
  assert.deepEqual(middle.map(line => [...line].length), final.map(line => [...line].length));
  assert.deepEqual(plain(2), final);
});

test("wordmark interpolates a continuous truecolor gradient instead of ten flat bands", () => {
  const colors = new Set([...colored(1).matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)]
    .map(match => match.slice(1).join(",")));
  assert.ok(colors.size > 40, `only ${colors.size} color levels`);
});

test("wordmark keeps its heavier contour without synthetic font-bold expansion", () => {
  const lines = terminalWordmark(76, createRainbow(true), "\x1b[0m");
  assert.doesNotMatch(lines.join("\n"), /\x1b\[1m/);
  assert.equal(withoutColor(lines.join("\n")), terminalWordmark(76, createRainbow(false), "").join("\n"));
  assert.doesNotMatch(terminalWordmark(76, createRainbow(false), "").join("\n"), /\x1b\[/);
});

test("wordmark preserves a separated dot texture without any solid fill glyphs", () => {
  const cells = terminalWordmark(76, createRainbow(false), "").join("");
  assert.doesNotMatch(cells, /[█▀▄▌▐▖▗▘▙▚▛▜▝▞▟]/);
  assert.match(cells, /[\u2801-\u28ff]/);
});

test("colors flow across a fully formed logo instead of only animating the contour", () => {
  const first = colored(0.45);
  const next = colored(0.7);
  assert.equal(withoutColor(first), withoutColor(colored(1)));
  assert.equal(withoutColor(next), withoutColor(colored(1)));
  assert.notEqual(first, next);
  assert.notEqual(next, colored(1));
});

test("narrow landing keeps its readable nonanimated wordmark", () => {
  const narrow = logoLines(48, createRainbow(false), "", 0);
  assert.match(narrow.join("\n"), /SessionBar/);
  assert.doesNotMatch(narrow.join("\n"), /\x1b\[/);
  assert.ok(narrow.length <= 4);
});

test("wordmark intro is finite and always settles on the exact static frame", async () => {
  const frames = [];
  await playWordmarkIntro(progress => frames.push(progress), () => false);
  assert.ok(frames.length >= 24 && frames.length <= 40);
  assert.equal(frames.at(-1), 1);
  assert.ok(frames.every((progress, index) => index === 0 || progress > frames[index - 1]));
});

test("menu input skips the remaining motion and preserves the static logo", async () => {
  const frames = [];
  await playWordmarkIntro(progress => frames.push(progress), () => true);
  assert.deepEqual(frames, [1]);
});

test("ambient logo loop is capped at four FPS and stops immediately", context => {
  assert.equal(typeof wordmark.startWordmarkLoop, "function");
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const frames = [];
  const stop = wordmark.startWordmarkLoop(frame => frames.push(frame), 46);
  context.mock.timers.tick(249);
  assert.deepEqual(frames, []);
  context.mock.timers.tick(1);
  assert.deepEqual(frames, [47]);
  context.mock.timers.tick(250);
  assert.deepEqual(frames, [47, 0]);
  stop();
  context.mock.timers.tick(5000);
  assert.deepEqual(frames, [47, 0]);
});
